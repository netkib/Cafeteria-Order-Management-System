import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { z } from "zod";
import { MongoClient, Collection } from "mongodb";
import Redis from "ioredis";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import client from "prom-client";

const SERVICE_NAME = process.env.SERVICE_NAME || "identity";
const NODE_ENV = process.env.NODE_ENV || "development";
const PORT = Number(process.env.PORT || 7001);
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/identity_db";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const JWT_SECRET = process.env.JWT_SECRET || "";
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

const LoginSchema = z.object({
  studentId: z.string().trim().min(3).max(64),
  password: z.string().min(6).max(128),
});

const WalletRechargeSchema = z.object({
  studentId: z.string().trim().min(3).max(64),
  amountBdt: z.number().int().min(1).max(100000),
});

const WalletDebitSchema = z.object({
  studentId: z.string().trim().min(3).max(64),
  amountBdt: z.number().int().min(1).max(100000),
  orderId: z.string().trim().min(6).max(128).optional(),
});

const AdminCreateStudentSchema = z.object({
  studentId: z.string().trim().min(3).max(64),
  name: z.string().trim().min(1).max(128),
  password: z.string().min(6).max(128),
  balanceBdt: z.number().int().min(0).max(100000).optional(),
});

type Role = "student" | "admin";

type WalletRecord = {
  amountBdt: number;
  at: Date;
  balanceAfterBdt: number;
  kind: "recharge" | "debit";
};

type UserDoc = {
  studentId: string;
  passwordHash: string;
  role: Role;
  name?: string;
  balanceBdt?: number;
  rechargeProcessed?: Record<string, WalletRecord>;
  debitProcessed?: Record<string, WalletRecord>;
  createdAt: Date;
  updatedAt: Date;
};

type WalletTxKind = "recharge" | "debit";

type WalletTxDoc = {
  kind: WalletTxKind;
  token: string;
  idempotencyKey: string;
  studentId: string;
  amountBdt: number;
  balanceAfterBdt: number;

  meta?: {
    orderId?: string;
  };

  source: "admin" | "gateway";
  createdAt: Date;
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

const walletRechargeTotal = new client.Counter({
  name: "wallet_recharge_total",
  help: "Total wallet recharge operations",
  labelNames: ["service", "result"],
});

const walletDebitTotal = new client.Counter({
  name: "wallet_debit_total",
  help: "Total wallet debit operations",
  labelNames: ["service", "result"],
});

const app = express();
app.use(helmet());
app.use(cors({ origin: "*", credentials: false }));
app.use(express.json({ limit: "256kb" }));
app.use(morgan("dev"));


let mongoClient: MongoClient;
let usersCol: Collection<UserDoc>;
let walletTxCol: Collection<WalletTxDoc>;
let redis: Redis;

function sha256Hex(input: string) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function errorResponse(res: Response, status: number, code: string, message: string, details?: any) {
  return res.status(status).json({
    ok: false,
    error: { code, message, details },
  });
}

function ok(res: Response, data: Record<string, any>) {
  return res.json({ ok: true, ...data });
}

function getIdempotencyKey(req: Request) {
  return String(req.header("Idempotency-Key") ?? "").trim();
}

function tokenForIdempotency(idempotencyKey: string, studentId: string) {
  return sha256Hex(`${idempotencyKey}:${studentId}`);
}

function buildJwtVerifyOptions(): jwt.VerifyOptions {
  const opts: jwt.VerifyOptions = { algorithms: ["HS256"] };
  if (JWT_ISSUER) opts.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) opts.audience = JWT_AUDIENCE;
  return opts;
}

function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction) {
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

function requireAdminSecret(req: Request, res: Response): boolean {
  const provided = String(req.header("x-admin-secret") ?? "").trim();
  if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
    errorResponse(res, 403, "FORBIDDEN", "Invalid admin secret");
    return false;
  }
  return true;
}

async function upsertWalletTx(params: {
  kind: WalletTxKind;
  token: string;
  idempotencyKey: string;
  studentId: string;
  amountBdt: number;
  balanceAfterBdt: number;
  source: "admin" | "gateway";
  meta?: { orderId?: string };
  createdAt: Date;
}) {
  try {
    await walletTxCol.updateOne(
      { kind: params.kind, token: params.token },
      {
        $setOnInsert: {
          kind: params.kind,
          token: params.token,
          idempotencyKey: params.idempotencyKey,
          studentId: params.studentId,
          amountBdt: params.amountBdt,
          balanceAfterBdt: params.balanceAfterBdt,
          meta: params.meta,
          source: params.source,
          createdAt: params.createdAt,
        },
      },
      { upsert: true }
    );
  } catch {}
}

async function checkLoginRateLimit(studentId: string) {
  // Simple per-student limit: 5 attempts per 60s
  const key = `login:attempts:${studentId}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, 60);
  return count <= 5;
}

async function resetLoginRateLimit(studentId: string) {
  const key = `login:attempts:${studentId}`;
  await redis.del(key);
}

async function connectMongo() {
  mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const db = mongoClient.db(); // db name comes from URI
  usersCol = db.collection<UserDoc>("users");
  await usersCol.createIndex({ studentId: 1 }, { unique: true });
  walletTxCol = db.collection<WalletTxDoc>("wallet_transactions");
  await walletTxCol.createIndex({ kind: 1, token: 1 }, { unique: true });
  await walletTxCol.createIndex({ studentId: 1, createdAt: -1 });
  await walletTxCol.createIndex({ createdAt: -1 });
}

async function connectRedis() {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  await redis.ping();
}

async function seedUsers() {
  const now = new Date();
  const ensureUser = async (studentId: string, password: string, role: Role, balanceBdt?: number, name?: string) => {
    const existing = await usersCol.findOne({ studentId });

    if (!existing) {
      const passwordHash = await bcrypt.hash(password, 10);
      const doc: UserDoc = {
        studentId,
        passwordHash,
        role,
        name: name ?? (role === "student" ? studentId : undefined),
        balanceBdt: role === "student" ? balanceBdt ?? 200 : undefined,
        rechargeProcessed: {},
        debitProcessed: {},
        createdAt: now,
        updatedAt: now,
      };
      await usersCol.insertOne(doc);
      return;
    }

    const update: any = { $set: { updatedAt: now } };
    let needs = false;

    if (existing.role === "student" && typeof existing.balanceBdt !== "number") {
      update.$set.balanceBdt = balanceBdt ?? 200;
      needs = true;
    }
    if (!existing.rechargeProcessed) {
      update.$set.rechargeProcessed = {};
      needs = true;
    }
    if (!existing.debitProcessed) {
      update.$set.debitProcessed = {};
      needs = true;
    }
    if (!existing.name && role === "student") {
      update.$set.name = name ?? existing.studentId;
      needs = true;
    }

    if (needs) {
      await usersCol.updateOne({ studentId }, update, { upsert: false });
    }
  };

  await ensureUser("student1", "password123", "student", 300, "Student One");
  await ensureUser("student2", "password123", "student", 150, "Student Two");
  await ensureUser("admin1", "admin123", "admin", undefined, "Admin");
}

//routes
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

// authentication route
app.post("/auth/login", async (req: Request, res: Response) => {
  const t0 = process.hrtime.bigint();
  const route = "/auth/login";

  try {
    if (!JWT_SECRET || JWT_SECRET.length < 16) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "500").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 500, "MISCONFIGURED", "JWT_SECRET is missing or too weak");
    }

    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid login payload", parsed.error.flatten());
    }

    const { studentId, password } = parsed.data;

    const allowed = await checkLoginRateLimit(studentId);
    if (!allowed) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "429").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "429").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 429, "RATE_LIMITED", "Too many login attempts. Try again later.");
    }

    const user = await usersCol.findOne({ studentId });
    if (!user) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "401").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "401").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 401, "UNAUTHORIZED", "Invalid credentials");
    }

    const okPass = await bcrypt.compare(password, user.passwordHash);
    if (!okPass) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "401").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "401").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 401, "UNAUTHORIZED", "Invalid credentials");
    }

    await resetLoginRateLimit(studentId);

    const payload: any = {
      sub: user.studentId,
      role: user.role,
    };

    const signOptions: jwt.SignOptions = {
      algorithm: "HS256",
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
    if (JWT_ISSUER) signOptions.issuer = JWT_ISSUER;
    if (JWT_AUDIENCE) signOptions.audience = JWT_AUDIENCE;

    const accessToken = jwt.sign(payload, JWT_SECRET, signOptions);

    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, {
      accessToken,
      role: user.role,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    });
  } catch {
    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Login failed");
  }
});



app.get("/me", authMiddleware, async (req: AuthedRequest, res: Response) => {
  const route = "/me";
  const t0 = process.hrtime.bigint();

  try {
    const { studentId, role } = req.auth!;
    const user = await usersCol.findOne(
      { studentId },
      { projection: { _id: 0, studentId: 1, role: 1, balanceBdt: 1 } }
    );

    if (!user) {
      httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "404").inc();
      httpRequestDuration.labels(SERVICE_NAME, "GET", route, "404").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 404, "NOT_FOUND", "User not found");
    }

    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, {
      studentId: user.studentId,
      role: user.role,
      balanceBdt: role === "student" ? Number(user.balanceBdt ?? 0) : undefined,
    });
  } catch {
    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to load profile");
  }
});



app.post("/wallet/recharge", async (req: Request, res: Response) => {
  const route = "/wallet/recharge";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
      return;
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
    }

    const parsed = WalletRechargeSchema.safeParse(req.body);
    if (!parsed.success) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid recharge payload", parsed.error.flatten());
    }

    const { studentId, amountBdt } = parsed.data;
    const token = tokenForIdempotency(idempotencyKey, studentId);
    const processedPath = `rechargeProcessed.${token}`;
    const now = new Date();

    const updated = await usersCol.findOneAndUpdate(
      {
        studentId,
        role: "student",
        [processedPath]: { $exists: false },
      } as any,
      [
        {
          $set: {
            balanceBdt: { $add: [{ $ifNull: ["$balanceBdt", 0] }, amountBdt] },
            updatedAt: now,
            rechargeProcessed: {
              $setField: {
                field: token,
                input: { $ifNull: ["$rechargeProcessed", {}] },
                value: {
                  amountBdt,
                  at: now,
                  balanceAfterBdt: { $add: [{ $ifNull: ["$balanceBdt", 0] }, amountBdt] },
                  kind: "recharge",
                },
              },
            },
          },
        },
      ] as any,
      { returnDocument: "after" }
    );

    if (!updated) {
      const user = await usersCol.findOne({ studentId });
      if (!user || user.role !== "student") {
        httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "404").inc();
        httpRequestDuration.labels(SERVICE_NAME, "POST", route, "404").observe(Number(process.hrtime.bigint() - t0) / 1e9);
        walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
        return errorResponse(res, 404, "NOT_FOUND", "Student not found");
      }

      const existing = (user.rechargeProcessed ?? {})[token];
      if (existing) {
        if (existing.amountBdt !== amountBdt) {
          httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
          httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
          walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
          return errorResponse(
            res,
            409,
            "IDEMPOTENCY_KEY_REUSE",
            "Idempotency-Key was already used with a different recharge amount",
            { previousAmountBdt: existing.amountBdt, newAmountBdt: amountBdt }
          );
        }

        httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
        httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);
        walletRechargeTotal.labels(SERVICE_NAME, "idempotent").inc();

        await upsertWalletTx({
          kind: "recharge",
          token,
          idempotencyKey,
          studentId,
          amountBdt,
          balanceAfterBdt: Number(user.balanceBdt ?? 0),
          source: "admin",
          createdAt: existing.at instanceof Date ? existing.at : new Date(),
        });

        return ok(res, {
          studentId,
          amountBdt,
          balanceBdt: Number(user.balanceBdt ?? 0),
          idempotentReplay: true,
        });
      }

      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 409, "RECHARGE_CONFLICT", "Recharge could not be applied");
    }

    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    walletRechargeTotal.labels(SERVICE_NAME, "success").inc();

    await upsertWalletTx({
      kind: "recharge",
      token,
      idempotencyKey,
      studentId,
      amountBdt,
      balanceAfterBdt: Number(updated.balanceBdt ?? 0),
      source: "admin",
      createdAt: now,
    });

    return ok(res, {
      studentId,
      amountBdt,
      balanceBdt: Number(updated.balanceBdt ?? 0),
      idempotentReplay: false,
    });
  } catch {
    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    walletRechargeTotal.labels(SERVICE_NAME, "fail").inc();
    return errorResponse(res, 500, "INTERNAL_ERROR", "Recharge failed");
  }
});


app.post("/wallet/debit", async (req: Request, res: Response) => {
  const route = "/wallet/debit";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
      return;
    }

    const idempotencyKey = getIdempotencyKey(req);
    if (!idempotencyKey) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 400, "MISSING_IDEMPOTENCY_KEY", "Idempotency-Key header is required");
    }

    const parsed = WalletDebitSchema.safeParse(req.body);
    if (!parsed.success) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid debit payload", parsed.error.flatten());
    }

    const { studentId, amountBdt, orderId: maybeOrderId } = parsed.data;
    const token = tokenForIdempotency(idempotencyKey, studentId);
    const processedPath = `debitProcessed.${token}`;
    const now = new Date();

    const updated = await usersCol.findOneAndUpdate(
      {
        studentId,
        role: "student",
        balanceBdt: { $gte: amountBdt },
        [processedPath]: { $exists: false },
      } as any,
      [
        {
          $set: {
            balanceBdt: { $subtract: [{ $ifNull: ["$balanceBdt", 0] }, amountBdt] },
            updatedAt: now,
            debitProcessed: {
              $setField: {
                field: token,
                input: { $ifNull: ["$debitProcessed", {}] },
                value: {
                  amountBdt,
                  at: now,
                  balanceAfterBdt: { $subtract: [{ $ifNull: ["$balanceBdt", 0] }, amountBdt] },
                  kind: "debit",
                },
              },
            },
          },
        },
      ] as any,
      { returnDocument: "after" }
    );

    if (!updated) {
      const user = await usersCol.findOne({ studentId });
      if (!user || user.role !== "student") {
        httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "404").inc();
        httpRequestDuration.labels(SERVICE_NAME, "POST", route, "404").observe(Number(process.hrtime.bigint() - t0) / 1e9);
        walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
        return errorResponse(res, 404, "NOT_FOUND", "Student not found");
      }

      const existing = (user.debitProcessed ?? {})[token];
      if (existing) {
        if (existing.amountBdt !== amountBdt) {
          httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
          httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
          walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
          return errorResponse(
            res,
            409,
            "IDEMPOTENCY_KEY_REUSE",
            "Idempotency-Key was already used with a different debit amount",
            { previousAmountBdt: existing.amountBdt, newAmountBdt: amountBdt }
          );
        }

        httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
        httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);
        walletDebitTotal.labels(SERVICE_NAME, "idempotent").inc();

        await upsertWalletTx({
          kind: "debit",
          token,
          idempotencyKey,
          studentId,
          amountBdt,
          balanceAfterBdt: Number(user.balanceBdt ?? 0),
          source: "gateway",
          meta: maybeOrderId ? { orderId: maybeOrderId } : undefined,
          createdAt: existing.at instanceof Date ? existing.at : new Date(),
        });

        return ok(res, {
          studentId,
          amountBdt,
          balanceBdt: Number(user.balanceBdt ?? 0),
          idempotentReplay: true,
        });
      }


      if (Number(user.balanceBdt ?? 0) < amountBdt) {
        httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
        httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
        walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
        return errorResponse(res, 409, "INSUFFICIENT_FUNDS", "Insufficient balance", {
          studentId,
          requiredBdt: amountBdt,
          availableBdt: Number(user.balanceBdt ?? 0),
        });
      }

      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
      return errorResponse(res, 409, "DEBIT_CONFLICT", "Debit could not be applied");
    }

    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    walletDebitTotal.labels(SERVICE_NAME, "success").inc();

    await upsertWalletTx({
      kind: "debit",
      token,
      idempotencyKey,
      studentId,
      amountBdt,
      balanceAfterBdt: Number(updated.balanceBdt ?? 0),
      source: "gateway",
      meta: maybeOrderId ? { orderId: maybeOrderId } : undefined,
      createdAt: now,
    });

    return ok(res, {
      studentId,
      amountBdt,
      balanceBdt: Number(updated.balanceBdt ?? 0),
      idempotentReplay: false,
    });
  } catch {
    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    walletDebitTotal.labels(SERVICE_NAME, "fail").inc();
    return errorResponse(res, 500, "INTERNAL_ERROR", "Debit failed");
  }
});


app.get("/admin/students", async (req: Request, res: Response) => {
  const route = "/admin/students";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "GET", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return;
    }

    const docs = await usersCol
      .find(
        {},
        {
          projection: {
            _id: 0,
            studentId: 1,
            role: 1,
            name: 1,
            balanceBdt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        }
      )
      .sort({ role: 1, studentId: 1 })
      .toArray();

    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, {
      students: docs.map((d) => ({
        studentId: d.studentId,
        role: d.role,
        name: d.name ?? d.studentId,
        balanceBdt: d.role === "student" ? Number(d.balanceBdt ?? 0) : undefined,
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      })),
    });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to list students", NODE_ENV === "development" ? String(e?.message ?? e) : undefined);
  }
});



app.post("/admin/students", async (req: Request, res: Response) => {
  const route = "/admin/students";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return;
    }

    const parsed = AdminCreateStudentSchema.safeParse(req.body);
    if (!parsed.success) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid student payload", parsed.error.flatten());
    }

    const { studentId, name, password, balanceBdt } = parsed.data;
    const now = new Date();

    const existing = await usersCol.findOne({ studentId });
    if (existing) {
      httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "409").inc();
      httpRequestDuration.labels(SERVICE_NAME, "POST", route, "409").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 409, "ALREADY_EXISTS", "studentId already exists");
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const doc: UserDoc = {
      studentId,
      passwordHash,
      role: "student",
      name,
      balanceBdt: typeof balanceBdt === "number" ? balanceBdt : 0,
      rechargeProcessed: {},
      debitProcessed: {},
      createdAt: now,
      updatedAt: now,
    };

    await usersCol.insertOne(doc);

    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, {
      studentId: doc.studentId,
      name: doc.name,
      role: doc.role,
      balanceBdt: Number(doc.balanceBdt ?? 0),
      createdAt: doc.createdAt,
    });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "POST", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "POST", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to create student", NODE_ENV === "development" ? String(e?.message ?? e) : undefined);
  }
});



app.delete("/admin/students/:studentId", async (req: Request, res: Response) => {
  const route = "/admin/students/:studentId";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return;
    }

    const studentId = String(req.params.studentId ?? "").trim();
    if (!studentId) {
      httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "400").inc();
      httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "400").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 400, "VALIDATION_ERROR", "Missing studentId");
    }

    const user = await usersCol.findOne({ studentId });
    if (!user) {
      httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "404").inc();
      httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "404").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 404, "NOT_FOUND", "Student not found");
    }

    if (user.role !== "student") {
      httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return errorResponse(res, 403, "FORBIDDEN", "Cannot delete admin accounts");
    }

    await usersCol.deleteOne({ studentId });

    httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, { deleted: true, studentId });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "DELETE", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "DELETE", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to delete student", NODE_ENV === "development" ? String(e?.message ?? e) : undefined);
  }
});



app.get("/admin/transactions", async (req: Request, res: Response) => {
  const route = "/admin/transactions";
  const t0 = process.hrtime.bigint();

  try {
    if (!requireAdminSecret(req, res)) {
      httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "403").inc();
      httpRequestDuration.labels(SERVICE_NAME, "GET", route, "403").observe(Number(process.hrtime.bigint() - t0) / 1e9);
      return;
    }

    const studentId = String(req.query.studentId ?? "").trim();
    const kind = String(req.query.kind ?? "").trim(); // recharge|debit
    const limitRaw = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

    const filter: any = {};
    if (studentId) filter.studentId = studentId;
    if (kind === "recharge" || kind === "debit") filter.kind = kind;

    const rows = await walletTxCol
      .find(filter, {
        projection: { _id: 0, kind: 1, studentId: 1, amountBdt: 1, balanceAfterBdt: 1, idempotencyKey: 1, createdAt: 1, source: 1, meta: 1 },
      })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "200").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "200").observe(Number(process.hrtime.bigint() - t0) / 1e9);

    return ok(res, { transactions: rows });
  } catch (e: any) {
    httpRequestsTotal.labels(SERVICE_NAME, "GET", route, "500").inc();
    httpRequestDuration.labels(SERVICE_NAME, "GET", route, "500").observe(Number(process.hrtime.bigint() - t0) / 1e9);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to load transactions", NODE_ENV === "development" ? String(e?.message ?? e) : undefined);
  }
});



app.post("/admin/kill", (req: Request, res: Response) => {
  if (!requireAdminSecret(req, res)) return;
  // respond first so UI sees success, then exit
  res.json({ ok: true, message: `${SERVICE_NAME} exiting (chaos)` });
  setTimeout(() => process.exit(1), 150);
});



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
  await seedUsers();

  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
  });
}

start().catch((e) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, e?.message ?? e);
  process.exit(1);
});