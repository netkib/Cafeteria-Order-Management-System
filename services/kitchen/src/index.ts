import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import Redis from "ioredis";
import client, { collectDefaultMetrics } from "prom-client";
import { z } from "zod";
import { Queue, Worker, QueueEvents, JobsOptions } from "bullmq";

dotenv.config();

const SERVICE_NAME = process.env.SERVICE_NAME ?? "kitchen";
const PORT = Number(process.env.PORT ?? 7004);
const REDIS_URL = process.env.REDIS_URL;
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? "dev_admin_secret_change_me";
const KITCHEN_QUEUE_NAME = process.env.KITCHEN_QUEUE_NAME ?? "orders";
const ORDER_STATUS_CHANNEL = process.env.ORDER_STATUS_CHANNEL ?? "orders:status";
const COOK_MIN_MS = Number(process.env.COOK_MIN_MS ?? 3000);
const COOK_MAX_MS = Number(process.env.COOK_MAX_MS ?? 7000);
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? 5);

if (!REDIS_URL) {
  console.error(`[${SERVICE_NAME}] Missing env REDIS_URL`);
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

const kitchenJobsEnqueuedTotal = new client.Counter({
  name: "kitchen_jobs_enqueued_total",
  help: "Total kitchen jobs enqueued",
  labelNames: ["service"],
});

const kitchenJobsProcessedTotal = new client.Counter({
  name: "kitchen_jobs_processed_total",
  help: "Total kitchen jobs processed successfully",
  labelNames: ["service"],
});

const kitchenJobsFailedTotal = new client.Counter({
  name: "kitchen_jobs_failed_total",
  help: "Total kitchen jobs failed",
  labelNames: ["service", "reason"],
});

const kitchenJobDuration = new client.Histogram({
  name: "kitchen_job_duration_seconds",
  help: "Kitchen job processing duration in seconds",
  labelNames: ["service", "result"],
  buckets: [1, 2, 3, 4, 5, 7, 10, 15],
});

function stableRouteLabel(req: Request) {
  return req.route?.path ? String(req.route.path) : req.path;
}

function errorResponse(res: Response, status: number, code: string, message: string, details?: unknown) {
  return res.status(status).json({ ok: false, error: { code, message, details } });
}

function parseRedisUrl(urlStr: string) {
  const u = new URL(urlStr);
  const port = u.port ? Number(u.port) : 6379;
  return { host: u.hostname, port };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number) {
  // inclusive min/max
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

const EnqueueSchema = z.object({
  orderId: z.string().trim().min(10).max(128),
  studentId: z.string().trim().min(3).max(64),
  itemId: z.string().trim().min(1).max(64),
  quantity: z.number().int().min(1).max(10),
});

type KitchenJob = z.infer<typeof EnqueueSchema>;
let redisPub: Redis;
let redisCmd: Redis;
let queue: Queue;
let worker: Worker;
let queueEvents: QueueEvents;

async function publishStatus(job: KitchenJob, status: "IN_KITCHEN" | "READY" | "FAILED", message?: string) {
  const payload = {
    orderId: job.orderId,
    studentId: job.studentId,
    status,
    message: message ?? null,
    at: new Date().toISOString(),
    source: SERVICE_NAME,
  };
  await redisPub.publish(ORDER_STATUS_CHANNEL, JSON.stringify(payload));
}

async function initRedisAndBull() {
  redisCmd = new Redis(REDIS_URL!, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  await redisCmd.ping();

  redisPub = new Redis(REDIS_URL!, {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });
  await redisPub.ping();

  const { host, port } = parseRedisUrl(REDIS_URL!);
  const connection = { host, port };

  queue = new Queue(KITCHEN_QUEUE_NAME, { connection });
  queueEvents = new QueueEvents(KITCHEN_QUEUE_NAME, { connection });
  await queueEvents.waitUntilReady();

  worker = new Worker(
    KITCHEN_QUEUE_NAME,
    async (job) => {
      const t0 = process.hrtime.bigint();
      const durationSec = () => Number(process.hrtime.bigint() - t0) / 1e9;
      const parsed = EnqueueSchema.safeParse(job.data);

      if (!parsed.success) {
        kitchenJobsFailedTotal.labels(SERVICE_NAME, "validation").inc();
        kitchenJobDuration.labels(SERVICE_NAME, "fail").observe(durationSec());
        throw new Error("Invalid job payload");
      }

      const data = parsed.data;

      await publishStatus(data, "IN_KITCHEN", "Cooking started");

      const cookMs = randomInt(COOK_MIN_MS, COOK_MAX_MS);
      await sleep(cookMs);
      await publishStatus(data, "READY", "Order is ready for pickup");

      kitchenJobsProcessedTotal.labels(SERVICE_NAME).inc();
      kitchenJobDuration.labels(SERVICE_NAME, "success").observe(durationSec());

      return { ok: true, cookMs };
    },
    { connection, concurrency: WORKER_CONCURRENCY }
  );

  worker.on("failed", async (job, err) => {
    kitchenJobsFailedTotal.labels(SERVICE_NAME, "worker_error").inc();
    try {
      if (job?.data) {
        const parsed = EnqueueSchema.safeParse(job.data);
        if (parsed.success) {
          await publishStatus(parsed.data, "FAILED", "Kitchen processing failed");
        }
      }
    } catch {}
    console.error(`[${SERVICE_NAME}] job failed:`, err?.message ?? err);
  });

  worker.on("error", (err) => {
    console.error(`[${SERVICE_NAME}] worker error:`, err?.message ?? err);
  });
}


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
  const deps: any = { redis: { ok: true }, worker: { ok: true } };

  try {
    await redisCmd.ping();
  } catch (e: any) {
    deps.redis = { ok: false, error: e?.message ?? "redis error" };
  }

  if (!worker || (worker as any).closed) {
    deps.worker = { ok: false, error: "worker not running" };
  }

  const ok = deps.redis.ok && deps.worker.ok;
  return res.status(ok ? 200 : 503).json({ service: SERVICE_NAME, ok, dependencies: deps });
});



app.get("/metrics", async (req, res) => {
  res.setHeader("Content-Type", client.register.contentType);
  res.send(await client.register.metrics());
});



app.post("/kitchen/enqueue", async (req, res, next) => {
  try {
    const parsed = EnqueueSchema.safeParse(req.body);
    if (!parsed.success) {
      kitchenJobsFailedTotal.labels(SERVICE_NAME, "validation").inc();
      return errorResponse(res, 400, "VALIDATION_ERROR", "Invalid request body", parsed.error.flatten());
    }

    const jobData = parsed.data;

    const opts: JobsOptions = {
      jobId: jobData.orderId,
      removeOnComplete: 1000,
      removeOnFail: 1000,
    };

    await queue.add("cook", jobData, opts);
    kitchenJobsEnqueuedTotal.labels(SERVICE_NAME).inc();

    return res.status(202).json({
      ok: true,
      enqueued: true,
      orderId: jobData.orderId,
    });
  } catch (err) {
    next(err);
  }
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

async function start() {
  await initRedisAndBull();

  app.listen(PORT, () => {
    console.log(`[${SERVICE_NAME}] listening on port ${PORT}`);
    console.log(
      `[${SERVICE_NAME}] queue="${KITCHEN_QUEUE_NAME}", channel="${ORDER_STATUS_CHANNEL}", cook=${COOK_MIN_MS}-${COOK_MAX_MS}ms, concurrency=${WORKER_CONCURRENCY}`
    );
  });
}



async function shutdown(signal: string) {
  console.log(`[${SERVICE_NAME}] received ${signal}, shutting down...`);
  try {
    await worker?.close();
  } catch {}
  try {
    await queueEvents?.close();
  } catch {}
  try {
    await queue?.close();
  } catch {}
  try {
    await redisPub?.quit();
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