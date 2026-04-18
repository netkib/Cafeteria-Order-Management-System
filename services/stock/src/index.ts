import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import Redis from "ioredis";
import { MongoClient, Collection } from "mongodb";
import client from "prom-client";
import {
  DecrementSchema,
  idemToken,
  processedPathForToken,
  buildDecrementFilter,
  buildDecrementUpdatePipeline,
} from "./stockLogic";

const SERVICE_NAME = process.env.SERVICE_NAME || "stock";
const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT || 7003);
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/stock_db";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

client.collectDefaultMetrics({ prefix: "prototype2_" });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["service", "method", "route", "status"],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.01, 0.03, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
});

const stockDecrementSuccessTotal = new client.Counter({
  name: "stock_decrement_success_total",
  help: "Total successful stock decrements",
  labelNames: ["service"],
});

const stockDecrementFailTotal = new client.Counter({
  name: "stock_decrement_fail_total",
  help: "Total failed stock decrements",
  labelNames: ["service", "reason"],
});

type ProcessedLedgerEntry = {
  quantity: number;
  at: Date;
  remaining: number;
};

type InventoryDoc = {
  itemId: string;
  name: string;
  quantity: number;
  priceBdt?: number;
  details?: string[];
  processed?: Record<string, ProcessedLedgerEntry>;
  createdAt: Date;
  updatedAt: Date;
};


const DEFAULT_ITEMS: Array<{
  itemId: string;
  name: string;
  quantity: number;
  priceBdt: number;
  details: string[];
}> = [
  { itemId: "ITEM01", name: "Iftar Box A", quantity: 0, priceBdt: 120, details: ["3 dates", "1 juice", "1 biriyani"] },
  { itemId: "ITEM02", name: "Iftar Box B", quantity: 8, priceBdt: 150, details: ["3 dates", "1 juice", "khichuri + chicken"] },
  { itemId: "ITEM03", name: "Water Bottle", quantity: 25, priceBdt: 20, details: ["500ml", "chilled"] },
];

const DEFAULT_PRICE_MAP: Record<string, number> = Object.fromEntries(
  DEFAULT_ITEMS.map((x) => [x.itemId, x.priceBdt])
);

const DEFAULT_NAME_MAP: Record<string, string> = Object.fromEntries(
  DEFAULT_ITEMS.map((x) => [x.itemId, x.name])
);

const DEFAULT_DETAILS_MAP: Record<string, string[]> = Object.fromEntries(
  DEFAULT_ITEMS.map((x) => [x.itemId, x.details])
);

const RestockSchema = z.object({
  itemId: z.string().trim().min(1).max(64),
  quantity: z.number().int().min(1).max(100000),
  priceBdt: z.number().int().min(0).max(100000).optional(),
  name: z.string().trim().min(1).max(128).optional(),
  details: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(30)
    .optional(),
});

const app = express();

app.use(helmet());
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "256kb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const route = (req as any).route?.path || req.path || "unknown";
    const status = String(res.statusCode);
    httpRequestsTotal.labels(SERVICE_NAME, req.method, route, status).inc();
    httpRequestDuration
      .labels(SERVICE_NAME, req.method, route, status)
      .observe(Number(process.hrtime.bigint() - t0) / 1e9);
  });
  next();
});

let mongoClient: MongoClient;
let inventoryCol: Collection<InventoryDoc>;
let redis: Redis;

function ok(res: Response, data: Record<string, any>) {
  return res.json({ ok: true, ...data });
}

function errorResponse(res: Response, status: number, code: string, message: string, details?: any) {
  return res.status(status).json({ ok: false, error: { code, message, details } });
}

function requireAdminSecret(req: Request, res: Response): boolean {
  const provided = String(req.header("x-admin-secret") ?? "").trim();
  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    errorResponse(res, 403, "FORBIDDEN", "Invalid admin secret");
    return false;
  }
  return true;
}

async function setStockCache(itemId: string, qty: number) {
  await redis.set(`stock:${itemId}`, String(qty), "EX", 60);
}

async function deleteStockCache(itemId: string) {
  await redis.del(`stock:${itemId}`);
}

async function connectMongo() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  inventoryCol = db.collection<InventoryDoc>("inventory");
  await inventoryCol.createIndex({ itemId: 1 }, { unique: true });
  await inventoryCol.createIndex({ createdAt: -1 });
  await inventoryCol.createIndex({ updatedAt: -1 });
}

async function connectRedis() {
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  await redis.ping();
}
async function seedAndBackfill() {

  const now = new Date();

  for (const item of DEFAULT_ITEMS) {
    const existing = await inventoryCol.findOne({ itemId: item.itemId });

    if (!existing) {
      await inventoryCol.insertOne({
        itemId: item.itemId,
        name: item.name,
        quantity: item.quantity,
        priceBdt: item.priceBdt,
        details: item.details,
        processed: {},
        createdAt: now,
        updatedAt: now,
      });
      await setStockCache(item.itemId, item.quantity);
      continue;
    }

    const set: any = { updatedAt: now };
    let needsUpdate = false;

    if (typeof existing.priceBdt !== "number") {
      set.priceBdt = DEFAULT_PRICE_MAP[item.itemId] ?? 0;
      needsUpdate = true;
    }

    if (!existing.name) {
      set.name = DEFAULT_NAME_MAP[item.itemId] ?? item.itemId;
      needsUpdate = true;
    }

    if (!Array.isArray(existing.details)) {
      set.details = DEFAULT_DETAILS_MAP[item.itemId] ?? [];
      needsUpdate = true;
    }

    if (!existing.processed) {
      set.processed = {};
      needsUpdate = true;
    }

    if (needsUpdate) {
      await inventoryCol.updateOne({ itemId: item.itemId }, { $set: set });
    }

    await setStockCache(item.itemId, Number(existing.quantity ?? 0));
  }

  await inventoryCol.updateMany(
    { priceBdt: { $exists: false } },
    { $set: { priceBdt: 0, updatedAt: now } }
  );

  await inventoryCol.updateMany(
    { details: { $exists: false } },
    { $set: { details: [], updatedAt: now } }
  );
}

app.get("/", (_req, res) => ok(res, { service: SERVICE_NAME, ok: true }));


app.get("/metrics", async (_req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.send(await client.register.metrics());
});


app.get("/health", async (_req, res) => {

  const deps: any = { mongo: { ok: false }, redis: { ok: false } };

  try {
    await mongoClient.db().command({ ping: 1 });
    deps.mongo.ok = true;
  } catch {
    deps.mongo.ok = false;
  }

  try {
    const pong = await redis.ping();
    deps.redis.ok = pong === "PONG";
  } catch {
    deps.redis.ok = false;
  }

  const okAll = deps.mongo.ok && deps.redis.ok;
  res.status(okAll ? 200 : 503).json({ service: SERVICE_NAME, ok: okAll, dependencies: deps });
});



app.get("/items", async (_req, res) => {
  const docs = await inventoryCol
    .find({}, { projection: { _id: 0, itemId: 1, name: 1, quantity: 1, priceBdt: 1, details: 1 } })
    .sort({ itemId: 1 })
    .toArray();

  return ok(res, {
    items: docs.map((d) => ({
      itemId: d.itemId,
      name: d.name,
      quantity: d.quantity,
      priceBdt: typeof d.priceBdt === "number" ? d.priceBdt : 0,
      details: Array.isArray(d.details) ? d.details : [],
    })),
  });
});



app.get("/stock/:itemId", async (req, res) => {
  const itemId = String(req.params.itemId ?? "").trim();
  if (!itemId) return errorResponse(res, 400, "VALIDATION_ERROR", "Missing itemId");

  const doc = await inventoryCol.findOne(
    { itemId },
    { projection: { _id: 0, itemId: 1, name: 1, quantity: 1, priceBdt: 1, details: 1 } }
  );
  if (!doc) return errorResponse(res, 404, "NOT_FOUND", "Item not found");

  return ok(res, {
    item: {
      itemId: doc.itemId,
      name: doc.name,
      quantity: doc.quantity,
      priceBdt: typeof doc.priceBdt === "number" ? doc.priceBdt : 0,
      details: Array.isArray(doc.details) ? doc.details : [],
    },
  });
});



app.get("/admin/items", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const docs = await inventoryCol
    .find(
      {},
      {
        projection: {
          _id: 0,
          itemId: 1,
          name: 1,
          quantity: 1,
          priceBdt: 1,
          details: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      }
    )
    .sort({ itemId: 1 })
    .toArray();

  return ok(res, {
    items: docs.map((d) => ({
      itemId: d.itemId,
      name: d.name,
      quantity: Number(d.quantity ?? 0),
      priceBdt: typeof d.priceBdt === "number" ? d.priceBdt : 0,
      details: Array.isArray(d.details) ? d.details : [],
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    })),
  });
});



app.delete("/admin/items/:itemId", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const itemId = String(req.params.itemId ?? "").trim();
  if (!itemId) return errorResponse(res, 400, "VALIDATION_ERROR", "Missing itemId");

  const existing = await inventoryCol.findOne({ itemId }, { projection: { _id: 0, itemId: 1 } });
  if (!existing) return errorResponse(res, 404, "NOT_FOUND", "Item not found");

  await inventoryCol.deleteOne({ itemId });

  await deleteStockCache(itemId);

  return ok(res, { deleted: true, itemId });
});



app.post("/stock/decrement", async (req, res) => {
  const parsed = DecrementSchema.safeParse(req.body);
  if (!parsed.success) {
    stockDecrementFailTotal.labels(SERVICE_NAME, "validation").inc();
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid payload", parsed.error.flatten());
  }

  const idempotencyKey = String(req.header("Idempotency-Key") ?? "").trim();
  if (!idempotencyKey) {
    stockDecrementFailTotal.labels(SERVICE_NAME, "missing_idem").inc();
    return errorResponse(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
  }

  const { itemId, quantity } = parsed.data;
  const now = new Date();
  const token = idemToken(idempotencyKey, itemId);
  const processedPath = processedPathForToken(token);
  const filter = buildDecrementFilter(itemId, quantity, processedPath);
  const pipeline = buildDecrementUpdatePipeline(token, quantity, now);

  const updatedDoc = await inventoryCol.findOneAndUpdate(filter as any, pipeline as any, {
    returnDocument: "after",
  });

  if (!updatedDoc) {

    const doc = await inventoryCol.findOne({ itemId });

    if (!doc) {
      stockDecrementFailTotal.labels(SERVICE_NAME, "not_found").inc();
      return errorResponse(res, 404, "NOT_FOUND", "Item not found");
    }

    const processed = (doc.processed ?? {})[token];
    if (processed) {
      stockDecrementSuccessTotal.labels(SERVICE_NAME).inc();
      await setStockCache(itemId, Number(doc.quantity ?? 0));
      return ok(res, {
        itemId,
        decremented: processed.quantity,
        remaining: processed.remaining,
        idempotentReplay: true,
      });
    }

    stockDecrementFailTotal.labels(SERVICE_NAME, "out_of_stock").inc();
    return errorResponse(res, 409, "OUT_OF_STOCK", "Insufficient stock", {
      itemId,
      requested: quantity,
      available: Number(doc.quantity ?? 0),
    });
  }

  const remaining = Number(updatedDoc.quantity ?? 0);
  await setStockCache(itemId, remaining);
  stockDecrementSuccessTotal.labels(SERVICE_NAME).inc();

  return ok(res, {
    itemId,
    decremented: quantity,
    remaining,
    idempotentReplay: false,
  });
});



app.post("/stock/restock", async (req, res) => {
  if (!requireAdminSecret(req, res)) return;

  const parsed = RestockSchema.safeParse(req.body);
  if (!parsed.success) {
    return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid restock payload", parsed.error.flatten());
  }

  const { itemId, quantity, priceBdt, name, details } = parsed.data;
  const now = new Date();
  const existing = await inventoryCol.findOne({ itemId });

  if (!existing) {
    if (!name || typeof priceBdt !== "number" || !Array.isArray(details) || details.length === 0) {
      return errorResponse(
        res,
        400,
        "VALIDATION_ERROR",
        "Creating a new item requires: name, priceBdt, and details[]",
        { required: ["name", "priceBdt", "details"] }
      );
    }

    await inventoryCol.insertOne({
      itemId,
      name,
      quantity,
      priceBdt,
      details,
      processed: {},
      createdAt: now,
      updatedAt: now,
    });

    await setStockCache(itemId, quantity);
    return ok(res, { itemId, quantity, priceBdt, name, details, created: true });
  }

  const newQty = Number(existing.quantity ?? 0) + quantity;

  const set: any = { quantity: newQty, updatedAt: now };
  if (typeof priceBdt === "number") set.priceBdt = priceBdt;
  if (typeof name === "string" && name.trim()) set.name = name.trim();
  if (Array.isArray(details) && details.length > 0) set.details = details;

  if (typeof existing.priceBdt !== "number" && typeof priceBdt !== "number") {
    set.priceBdt = DEFAULT_PRICE_MAP[itemId] ?? 0;
  }
  if (!Array.isArray(existing.details) && !(Array.isArray(details) && details.length > 0)) {
    set.details = DEFAULT_DETAILS_MAP[itemId] ?? [];
  }

  await inventoryCol.updateOne({ itemId }, { $set: set });
  await setStockCache(itemId, newQty);

  return ok(res, {
    itemId,
    quantity: newQty,
    priceBdt: typeof set.priceBdt === "number" ? set.priceBdt : Number(existing.priceBdt ?? 0),
    name: typeof set.name === "string" ? set.name : existing.name,
    details: Array.isArray(set.details) ? set.details : (Array.isArray(existing.details) ? existing.details : []),
    created: false,
  });
});



app.post("/admin/kill", (req, res) => {
  if (!requireAdminSecret(req, res)) return;
  res.json({ ok: true, message: `${SERVICE_NAME} exiting (chaos)` });
  setTimeout(() => process.exit(1), 150);
});



app.use((_req, res) => errorResponse(res, 404, "NOT_FOUND", "Route not found"));



app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  return errorResponse(
    res,
    500,
    "INTERNAL_ERROR",
    "Unhandled error",
    NODE_ENV === "development" ? String(err?.message ?? err) : undefined
  );
});


async function start() {
  await connectMongo();
  await connectRedis();
  await seedAndBackfill();

  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, e?.message ?? e);
  process.exit(1);
});