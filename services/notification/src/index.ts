import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import Redis from "ioredis";
import client, { collectDefaultMetrics } from "prom-client";
import { Server } from "socket.io";
import http from "http";
import jwt from "jsonwebtoken";
import { z } from "zod";

dotenv.config();

const SERVICE_NAME = process.env.SERVICE_NAME ?? "notification";
const PORT = Number(process.env.PORT ?? 7005);
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "dev_admin_secret_change_me";
const ORDER_STATUS_CHANNEL = process.env.ORDER_STATUS_CHANNEL ?? "orders:status";
const JWT_SECRET = process.env.JWT_SECRET ?? "";
const JWT_ISSUER = process.env.JWT_ISSUER;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE;

if (!REDIS_URL) {
  console.error(`[${SERVICE_NAME}] Missing env REDIS_URL`);
  process.exit(1);
}
if (!JWT_SECRET || JWT_SECRET.length < 16) {
  console.error(`[${SERVICE_NAME}] Missing/weak JWT_SECRET (>=16 chars).`);
  process.exit(1);
}

collectDefaultMetrics({ register: client.register });

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["service", "method", "route", "status"],
});

const httpRequestDuration = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["service", "method", "route", "status"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

const wsConnectionsCurrent = new client.Gauge({
  name: "ws_connections_current",
  help: "Current active websocket connections",
  labelNames: ["service"],
});

const wsMessagesSentTotal = new client.Counter({
  name: "ws_messages_sent_total",
  help: "Total websocket messages sent",
  labelNames: ["service", "type"],
});

const statusEventsReceivedTotal = new client.Counter({
  name: "status_events_received_total",
  help: "Total status events received from Redis pub/sub",
  labelNames: ["service"],
});

function stableRouteLabel(req: Request) {
  return req.route?.path ? String(req.route.path) : req.path;
}

function errorResponse(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ ok: false, error: { code, message, details } });
}

const StatusEventSchema = z.object({
  orderId: z.string().min(10),
  studentId: z.string().min(3),
  status: z.enum(["PENDING", "STOCK_VERIFIED", "IN_KITCHEN", "READY", "FAILED"]),
  message: z.union([z.string(), z.null()]).optional(),
  at: z.string().optional(),
  source: z.string().optional(),
});

let redisSub: Redis;
let redisCmd: Redis;

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "64kb" }));

app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = stableRouteLabel(req);
    const status = String(res.statusCode);

    httpRequestsTotal.labels(SERVICE_NAME, req.method, route, status).inc();
    httpRequestDuration.labels(SERVICE_NAME, req.method, route, status).observe(durationSec);
  });
  next();
});

app.get("/", (req, res) => {
  res.json({ service: SERVICE_NAME, ok: true });
});

app.get("/health", async (req, res) => {
  const deps: any = { redis: { ok: true }, subscription: { ok: true } };

  try {
    await redisCmd.ping();
  } catch (e: any) {
    deps.redis = { ok: false, error: e?.message ?? "redis error" };
  }

  const subReady = redisSub && (redisSub.status === "ready" || redisSub.status === "connect");
  if (!subReady) deps.subscription = { ok: false, error: `sub_status_${redisSub?.status ?? "none"}` };

  const ok = deps.redis.ok && deps.subscription.ok;
  return res.status(ok ? 200 : 503).json({ service: SERVICE_NAME, ok, dependencies: deps });
});



app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.send(await client.register.metrics());
});



app.post("/admin/kill", (req, res) => {
  const secret = req.header("x-admin-secret");
  if (secret !== ADMIN_SECRET) {
    return errorResponse(res, 401, "UNAUTHORIZED", "Missing/invalid admin secret");
  }
  res.json({ ok: true, message: `${SERVICE_NAME} exiting now...` });
  setTimeout(() => process.exit(1), 250);
});



app.use((req, res) => {
  return errorResponse(res, 404, "NOT_FOUND", "Route not found");
});



app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  console.error(`[${SERVICE_NAME}] error:`, err?.stack ?? err);
  return errorResponse(res, 500, "INTERNAL_ERROR", "Internal server error");
});

type SocketUser = { studentId: string; role: string };

function verifyToken(token: string): SocketUser {
  const options: jwt.VerifyOptions = {
    algorithms: ["HS256"],
  };

  if (JWT_ISSUER) options.issuer = JWT_ISSUER;
  if (JWT_AUDIENCE) options.audience = JWT_AUDIENCE;

  const decoded = jwt.verify(token, JWT_SECRET, options) as any;

  const studentId = String(decoded?.sub ?? "");
  const role = String(decoded?.role ?? "");

  if (!studentId) throw new Error("missing sub");
  return { studentId, role };
}

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: "*" },
});

io.use((socket, next) => {
  try {
    const token =
      String((socket.handshake.auth as any)?.token ?? "") ||
      String((socket.handshake.query as any)?.token ?? "");

    if (!token) return next(new Error("missing token"));

    const user = verifyToken(token);
    (socket.data as any).user = user;
    return next();
  } catch (e: any) {
    console.error(`[${SERVICE_NAME}] socket auth failed:`, e?.message ?? e);
    return next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  wsConnectionsCurrent.labels(SERVICE_NAME).inc();

  const user: SocketUser = (socket.data as any).user;
  const studentRoom = `student:${user.studentId}`;
  socket.join(studentRoom);

  socket.on("subscribe", (payload: any) => {
    const orderId = String(payload?.orderId ?? "").trim();
    if (orderId.length >= 10) {
      socket.join(`order:${orderId}`);
    }
  });

  socket.on("unsubscribe", (payload: any) => {
    const orderId = String(payload?.orderId ?? "").trim();
    if (orderId.length >= 10) {
      socket.leave(`order:${orderId}`);
    }
  });

  socket.on("disconnect", () => {
    wsConnectionsCurrent.labels(SERVICE_NAME).dec();
  });
});


async function initRedisAndSubscribe() {
  redisCmd = new Redis(REDIS_URL!, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  await redisCmd.ping();

  redisSub = new Redis(REDIS_URL!, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

  await redisSub.subscribe(ORDER_STATUS_CHANNEL);

  redisSub.on("message", (channel, message) => {
    if (channel !== ORDER_STATUS_CHANNEL) return;

    statusEventsReceivedTotal.labels(SERVICE_NAME).inc();

    let parsed: any;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }

    const validated = StatusEventSchema.safeParse(parsed);
    if (!validated.success) {
      return;
    }

    const evt = validated.data;

    io.to(`student:${evt.studentId}`).emit("orderStatus", evt);
    io.to(`order:${evt.orderId}`).emit("orderStatus", evt);

    wsMessagesSentTotal.labels(SERVICE_NAME, "orderStatus").inc();
  });

  redisSub.on("error", (err) => {
    console.error(`[${SERVICE_NAME}] redisSub error:`, err?.message ?? err);
  });
}

async function start() {
  await initRedisAndSubscribe();

  httpServer.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
    console.log(`[${SERVICE_NAME}] subscribed channel="${ORDER_STATUS_CHANNEL}"`);
  });
}

async function shutdown(signal: string) {
  console.log(`[${SERVICE_NAME}] received ${signal}, shutting down...`);
  try {
    io.close();
  } catch {}
  try {
    httpServer.close();
  } catch {}
  try {
    await redisSub?.quit();
  } catch {}
  try {
    await redisCmd?.quit();
  } catch {}
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start().catch((e) => {
  console.error(`[${SERVICE_NAME}] failed to start:`, e);
  process.exit(1);
});