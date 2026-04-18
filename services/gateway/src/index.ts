import express, { Request, Response as ExpressResponse, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import Redis from "ioredis";
import { MongoClient, Collection } from "mongodb";
import client from "prom-client";
import { Queue } from "bullmq";


const SERVICE_NAME = process.env.SERVICE_NAME || "gateway";
const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT || 7002);
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/orders_db";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const STOCK_URL = process.env.STOCK_URL || "http://stock:7003";
const IDENTITY_URL = process.env.IDENTITY_URL || "http://identity:7001";
const ORDER_STATUS_CHANNEL = process.env.ORDER_STATUS_CHANNEL || "orders:status";

const CreateOrderSchema = z.object({
  itemId: z.string().trim().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
});

type Role = "student" | "admin";
type OrderStatus = "PENDING" | "STOCK_VERIFIED" | "IN_KITCHEN" | "READY" | "FAILED";

type OrderEvent = {
  status: OrderStatus;
  at: Date;
  message?: string;
};

type OrderDoc = {
  orderId: string;
  studentId: string;
  itemId: string;
  quantity: number;
  requestHash: string;
  idempotencyKey: string;
  status: OrderStatus;
  events: OrderEvent[];
  priceBdt?: number;
  amountBdt?: number;
  createdAt: Date;
  updatedAt: Date;
};

type AuthedRequest = Request & {
  auth?: { studentId: string; role: Role };
};

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

const ordersCreatedTotal = new client.Counter({
  name: "orders_created_total",
  help: "Total orders created",
  labelNames: ["service"],
});

const ordersFailedTotal = new client.Counter({
  name: "orders_failed_total",
  help: "Total order create failures",
  labelNames: ["service", "reason"],
});

const app = express();
app.use(helmet());
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "256kb" }));

//metrics middleware 
app.use((req: Request, res: ExpressResponse, next: NextFunction) => {
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
let ordersCol: Collection<OrderDoc>;
let redis: Redis;

const redisUrl = new URL(REDIS_URL);
const queue = new Queue("orders", {
  connection: {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || "6379"),
    password: redisUrl.password ? decodeURIComponent(redisUrl.password) : undefined,
  },
});

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function errorResponse(res: ExpressResponse, status: number, code: string, message: string, details?: any) {
  return res.status(status).json({ ok: false, error: { code, message, details } });
}

function ok(res: ExpressResponse, data: Record<string, any>) {
  return res.json({ ok: true, ...data });
}

function getIdempotencyKey(req: Request) {
  return String(req.header("Idempotency-Key") ?? "").trim();
}

function requireAdminSecret(req: Request, res: ExpressResponse): boolean {
  const provided = String(req.header("x-admin-secret") ?? "").trim();
  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    errorResponse(res, 403, "FORBIDDEN", "Invalid admin secret");
    return false;
  }
  return true;
}

function computeOrderId(studentId: string, idempotencyKey: string) {
  return sha256Hex(`${studentId}:${idempotencyKey}`);
}

function computeRequestHash(itemId: string, quantity: number) {
  return sha256Hex(`${itemId}:${quantity}`);
}

function buildJwtVerifyOptions(): jwt.VerifyOptions {
  const opts: jwt.VerifyOptions = { algorithms: ["HS256"] };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) opts.audience = JWT_AUDIENCE;
  return opts;
}

function authMiddleware(req: AuthedRequest, res: ExpressResponse, next: NextFunction) {
  const header = String(req.header("Authorization") ?? "");
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return errorResponse(res, 401, "UNAUTHORIZED", "Missing bearer token");

  const token = m[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET, buildJwtVerifyOptions()) as any;
    const studentId = String(decoded?.sub ?? "").trim();
    const role = String(decoded?.role ?? "").trim() as Role;

    if (!studentId || (role !== "student" && role !== "admin")) {
      return errorResponse(res, 401, "UNAUTHORIZED", "Invalid token claims");
    }

    req.auth = { studentId, role };
    return next();
  } catch {
    return errorResponse(res, 401, "UNAUTHORIZED", "Invalid or expired token");
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 4000): Promise<globalThis.Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonSafe(res: globalThis.Response) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function getStockCache(itemId: string): Promise<number | null> {
  const key = `stock:${itemId}`;
  const v = await redis.get(key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function setStockCache(itemId: string, qty: number) {
  const key = `stock:${itemId}`;
  await redis.set(key, String(qty), "EX", 60);
}

const FALLBACK_PRICES_BDT: Record<string, number> = {
  ITEM01: 120,
  ITEM02: 150,
  ITEM03: 20,
};

async function fetchItemPriceBdt(itemId: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${STOCK_URL}/items`, { method: "GET" }, 3000);
    if (!res.ok) return FALLBACK_PRICES_BDT[itemId] ?? 0;

    const body = await readJsonSafe(res);
    const items = body?.items;
    if (!Array.isArray(items)) return FALLBACK_PRICES_BDT[itemId] ?? 0;

    const found = items.find((x: any) => x?.itemId === itemId);
    const price = Number(found?.priceBdt);
    if (Number.isFinite(price) && price >= 0) return price;

    return FALLBACK_PRICES_BDT[itemId] ?? 0;
  } catch {
    return FALLBACK_PRICES_BDT[itemId] ?? 0;
  }
}

async function walletDebit(params: { studentId: string; amountBdt: number; idempotencyKey: string; orderId?: string }) {
  const res = await fetchWithTimeout(
    `${IDENTITY_URL}/wallet/debit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": ADMIN_SECRET,
        "Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({
        studentId: params.studentId,
        amountBdt: params.amountBdt,
        orderId: params.orderId,
      }),
    },
    4000
  );

  const body = await readJsonSafe(res);
  return { status: res.status, ok: res.ok, body };
}

async function walletRefundRecharge(params: { studentId: string; amountBdt: number; idempotencyKey: string }) {
  try {
    const res = await fetchWithTimeout(
      `${IDENTITY_URL}/wallet/recharge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": ADMIN_SECRET,
          "Idempotency-Key": params.idempotencyKey,
        },
        body: JSON.stringify({ studentId: params.studentId, amountBdt: params.amountBdt }),
      },
      4000
    );
    const body = await readJsonSafe(res);
    return { status: res.status, ok: res.ok, body };
  } catch {
    return { status: 0, ok: false, body: null };
  }
}

async function stockDecrement(params: { itemId: string; quantity: number; idempotencyKey: string }) {
  const res = await fetchWithTimeout(
    `${STOCK_URL}/stock/decrement`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": params.idempotencyKey,
      },
      body: JSON.stringify({ itemId: params.itemId, quantity: params.quantity }),
    },
    4000
  );
  const body = await readJsonSafe(res);
  return { status: res.status, ok: res.ok, body };
}

async function startStatusSubscriber() {
  const sub = redis.duplicate();
  await (sub as any).connect?.().catch(() => {});
  await sub.subscribe(ORDER_STATUS_CHANNEL);

  sub.on("message", async (_channel, message) => {
    try {
      const evt = JSON.parse(message);
      const orderId = String(evt?.orderId ?? "");
      const status = String(evt?.status ?? "");
      const msg = evt?.message ? String(evt.message) : undefined;

      if (!orderId || !status) return;

      const now = new Date();
      await ordersCol.updateOne(
        { orderId },
        {
          $set: { status: status as any, updatedAt: now },
          $push: { events: { status: status as any, at: now, message: msg } },
        }
      );
    } catch {}
  });
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



app.get("/orders/:orderId", authMiddleware, async (req: AuthedRequest, res: ExpressResponse) => {
  const orderId = String(req.params.orderId ?? "").trim();
  if (!orderId) return errorResponse(res, 400, "VALIDATION_ERROR", "Missing orderId");

  const doc = await ordersCol.findOne({ orderId });
  if (!doc) return errorResponse(res, 404, "NOT_FOUND", "Order not found");

  if (req.auth!.role !== "admin" && doc.studentId !== req.auth!.studentId) {
    return errorResponse(res, 403, "FORBIDDEN", "Not allowed");
  }

  return ok(res, {
    orderId: doc.orderId,
    status: doc.status,
    itemId: doc.itemId,
    quantity: doc.quantity,
    priceBdt: doc.priceBdt,
    amountBdt: doc.amountBdt,
    events: (doc.events || []).map((e) => ({ status: e.status, at: e.at, message: e.message })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
});



app.get("/admin/orders", async (req: Request, res: ExpressResponse) => {
  const route = "/admin/orders";
  try {
    if (!requireAdminSecret(req, res)) return;

    const studentId = String(req.query.studentId ?? "").trim();
    const status = String(req.query.status ?? "").trim(); // PENDING|... optional
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

    const filter: any = {};
    if (studentId) filter.studentId = studentId;
    if (status) filter.status = status;

    const docs = await ordersCol
      .find(filter, {
        projection: {
          _id: 0,
          orderId: 1,
          studentId: 1,
          itemId: 1,
          quantity: 1,
          status: 1,
          idempotencyKey: 1,
          requestHash: 1,
          priceBdt: 1,
          amountBdt: 1,
          createdAt: 1,
          updatedAt: 1,
          events: 1,
        },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "200").inc();

    return ok(res, {
      orders: docs.map((d) => ({
        orderId: d.orderId,
        studentId: d.studentId,
        itemId: d.itemId,
        quantity: d.quantity,
        status: d.status,
        idempotencyKey: d.idempotencyKey,
        priceBdt: d.priceBdt,
        amountBdt: d.amountBdt,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
        events: (d.events || []).map((e: any) => ({ status: e.status, at: e.at, message: e.message })),
      })),
    });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "500").inc();
    return errorResponse(
      res,
      500,
      "INTERNAL_ERROR",
      "Failed to load orders",
      NODE_ENV === "development" ? String(e?.message ?? e) : undefined
    );
  }
});



app.get("/admin/orders/:orderId", async (req: Request, res: ExpressResponse) => {
  const route = "/admin/orders/:orderId";
  try {
    if (!requireAdminSecret(req, res)) return;

    const orderId = String(req.params.orderId ?? "").trim();
    if (!orderId) return errorResponse(res, 400, "VALIDATION_ERROR", "Missing orderId");

    const doc = await ordersCol.findOne(
      { orderId },
      {
        projection: {
          _id: 0,
          orderId: 1,
          studentId: 1,
          itemId: 1,
          quantity: 1,
          status: 1,
          idempotencyKey: 1,
          requestHash: 1,
          priceBdt: 1,
          amountBdt: 1,
          createdAt: 1,
          updatedAt: 1,
          events: 1,
        },
      }
    );

    if (!doc) {
      httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "404").inc();
      return errorResponse(res, 404, "NOT_FOUND", "Order not found");
    }

    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "200").inc();

    return ok(res, {
      order: {
        orderId: doc.orderId,
        studentId: doc.studentId,
        itemId: doc.itemId,
        quantity: doc.quantity,
        status: doc.status,
        idempotencyKey: doc.idempotencyKey,
        priceBdt: doc.priceBdt,
        amountBdt: doc.amountBdt,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        events: (doc.events || []).map((e: any) => ({ status: e.status, at: e.at, message: e.message })),
      },
    });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "500").inc();
    return errorResponse(
      res,
      500,
      "INTERNAL_ERROR",
      "Failed to load order",
      NODE_ENV === "development" ? String(e?.message ?? e) : undefined
    );
  }
});



app.post("/orders", authMiddleware, async (req: AuthedRequest, res: ExpressResponse) => {
  try {
    if (!JWT_SECRET || JWT_SECRET.length < 16) {
      ordersFailedTotal.labels(SERVICE_NAME, "misconfigured").inc();
      return errorResponse(res, 500, "MISCONFIGURED", "JWT_SECRET is missing or too weak");
    }
    if (!ADMIN_SECRET) {
      ordersFailedTotal.labels(SERVICE_NAME, "misconfigured").inc();
      return errorResponse(res, 500, "MISCONFIGURED", "ADMIN_SECRET is missing");
    }

    const parsed = CreateOrderSchema.safeParse(req.body);
    if (!parsed.success) {
      ordersFailedTotal.labels(SERVICE_NAME, "validation").inc();
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid order payload", parsed.error.flatten());
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      ordersFailedTotal.labels(SERVICE_NAME, "missing_idem").inc();
      return errorResponse(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
    }

    const { itemId, quantity } = parsed.data;
    const { studentId } = req.auth!;
    const orderId = computeOrderId(studentId, idempotencyKey);
    const reqHash = computeRequestHash(itemId, quantity);
    const existing = await ordersCol.findOne({ orderId });

    if (existing) {
      if (existing.requestHash !== reqHash) {
        ordersFailedTotal.labels(SERVICE_NAME, "idem_reuse").inc();
        return errorResponse(
          res,
          409,
          "IDEMPOTENCY_KEY_REUSE",
          "Idempotency-Key was already used with a different payload"
        );
      }

      return ok(res, {
        orderId: existing.orderId,
        status: existing.status,
        message: "Idempotent replay",
        events: (existing.events || []).map((e) => ({ status: e.status, at: e.at, message: e.message })),
      });
    }

    const cachedStock = await getStockCache(itemId);
    if (cachedStock === 0) {
      ordersFailedTotal.labels(SERVICE_NAME, "out_of_stock_cache").inc();
      return errorResponse(res, 409, "OUT_OF_STOCK", "Item out of stock (cache)");
    }

    const priceBdt = await fetchItemPriceBdt(itemId);
    const amountBdt = Math.max(0, Math.floor(priceBdt * quantity));

    if (amountBdt > 0) {
      const debit = await walletDebit({ studentId, amountBdt, idempotencyKey, orderId });
      if (!debit.ok) {
        const code = String(debit.body?.error?.code ?? `HTTP_${debit.status}`);
        const msg = String(debit.body?.error?.message ?? "Wallet debit failed");
        ordersFailedTotal.labels(SERVICE_NAME, "wallet_debit_fail").inc();
        return res.status(debit.status || 500).json(debit.body ?? { ok: false, error: { code, message: msg } });
      }
    }

    const dec = await stockDecrement({ itemId, quantity, idempotencyKey });
    if (!dec.ok) {
      if (amountBdt > 0) {
        const refundKey = `${idempotencyKey}:refund`;
        await walletRefundRecharge({ studentId, amountBdt, idempotencyKey: refundKey });
      }

      const code = String(dec.body?.error?.code ?? `HTTP_${dec.status}`);
      const msg = String(dec.body?.error?.message ?? "Stock decrement failed");
      ordersFailedTotal.labels(SERVICE_NAME, "stock_fail").inc();
      return res.status(dec.status || 500).json(dec.body ?? { ok: false, error: { code, message: msg } });
    }

    const remaining = Number(dec.body?.remaining);
    if (Number.isFinite(remaining)) {
      await setStockCache(itemId, remaining);
    }

    const now = new Date();
    const doc: OrderDoc = {
      orderId,
      studentId,
      itemId,
      quantity,
      requestHash: reqHash,
      idempotencyKey,
      status: "PENDING",
      events: [{ status: "PENDING", at: now, message: "Order accepted" }],
      priceBdt,
      amountBdt,
      createdAt: now,
      updatedAt: now,
    };

    await ordersCol.insertOne(doc);
    await queue.add("order", { orderId, studentId, itemId, quantity }, { jobId: orderId, removeOnComplete: true, attempts: 2 });

    ordersCreatedTotal.labels(SERVICE_NAME).inc();

    return ok(res, {
      orderId,
      status: "PENDING",
      message: "Order accepted",
      priceBdt,
      amountBdt,
    });
  } catch {
    ordersFailedTotal.labels(SERVICE_NAME, "internal").inc();
    return errorResponse(res, 500, "INTERNAL_ERROR", "Order create failed");
  }
});



app.post("/admin/kill", (req: Request, res: ExpressResponse) => {
  if (!requireAdminSecret(req, res)) return;
  res.json({ ok: true, message: `${SERVICE_NAME} exiting (chaos)` });
  setTimeout(() => process.exit(1), 150);
});



app.use((_req: Request, res: ExpressResponse) => errorResponse(res, 404, "NOT_FOUND", "Route not found"));



app.use((err: any, _req: Request, res: ExpressResponse, _next: NextFunction) => {
  return errorResponse(
    res,
    500,
    "INTERNAL_ERROR",
    "Unhandled error",
    NODE_ENV === "development" ? String(err?.message ?? err) : undefined
  );
});

async function start() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db();
  ordersCol = db.collection<OrderDoc>("orders");
  await ordersCol.createIndex({ orderId: 1 }, { unique: true });
  await ordersCol.createIndex({ studentId: 1 });
  await ordersCol.createIndex({ createdAt: -1 });
  redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
  await redis.ping();
  await startStatusSubscriber().catch(() => {});

  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, e?.message ?? e);
  process.exit(1);
});