import type { MetricsSnapshot, ServiceName } from "../types";

export type PromSample = {
  value: number;
  labels: Record<string, string>;
};

export type PromMap = Record<string, PromSample[]>;

function parseLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const parts = raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/); // split commas not inside quotes
  for (const p of parts) {
    const m = p.match(/^\s*([^=]+)="(.*)"\s*$/);
    if (!m) continue;
    const k = m[1].trim();
    const v = m[2].replace(/\\"/g, '"');
    labels[k] = v;
  }
  return labels;
}

export function parsePrometheus(text: string): PromMap {
  const map: PromMap = {};
  const lines = text.split("\n");

  for (const line of lines) {

    const s = line.trim();

    if (!s || s.startsWith("#")) continue;

    const withLabels = s.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\{(.+)\}\s+([-+]?\d+(\.\d+)?([eE][-+]?\d+)?)$/);
    if (withLabels) {
      const name = withLabels[1];
      const labelStr = withLabels[2];
      const value = Number(withLabels[3]);
      if (!Number.isFinite(value)) continue;

      const sample: PromSample = { value, labels: parseLabels(labelStr) };
      (map[name] ??= []).push(sample);
      continue;
    }

    const plain = s.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+([-+]?\d+(\.\d+)?([eE][-+]?\d+)?)$/);
    if (plain) {
      const name = plain[1];
      const value = Number(plain[2]);
      if (!Number.isFinite(value)) continue;

      const sample: PromSample = { value, labels: {} };
      (map[name] ??= []).push(sample);
      continue;
    }
  }

  return map;
}

export function sumMetric(map: PromMap, name: string, match?: Record<string, string>): number | undefined {
  const samples = map[name];
  if (!samples || samples.length === 0) return undefined;

  let total = 0;
  let found = false;

  for (const s of samples) {
    if (match) {
      let ok = true;
      for (const [k, v] of Object.entries(match)) {
        if (s.labels[k] !== v) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    total += s.value;
    found = true;
  }

  return found ? total : undefined;
}

export function avgLatencyMs(map: PromMap, labelMatch?: Record<string, string>): number | undefined {
  const sum = sumMetric(map, "http_request_duration_seconds_sum", labelMatch);
  const count = sumMetric(map, "http_request_duration_seconds_count", labelMatch);
  if (sum === undefined || count === undefined || count <= 0) return undefined;
  return (sum / count) * 1000;
}

export function computeRps(prevTotal: number | undefined, nextTotal: number | undefined, deltaMs: number): number | undefined {
  if (prevTotal === undefined || nextTotal === undefined) return undefined;
  if (deltaMs <= 0) return undefined;
  const delta = nextTotal - prevTotal;
  if (delta < 0) return undefined;
  return delta / (deltaMs / 1000);
}


export function buildSnapshot(service: ServiceName, text: string): MetricsSnapshot {
  const map = parsePrometheus(text);

  const httpTotal = sumMetric(map, "http_requests_total", { service });
  const latency = avgLatencyMs(map, { service });

  const ordersCreated = sumMetric(map, "orders_created_total", { service });
  const ordersFailed = sumMetric(map, "orders_failed_total", { service });

  const stockOk = sumMetric(map, "stock_decrement_success_total", { service });
  const stockFail = sumMetric(map, "stock_decrement_fail_total", { service });

  const kitchenOk = sumMetric(map, "kitchen_jobs_processed_total", { service });
  const kitchenFail = sumMetric(map, "kitchen_jobs_failed_total", { service });

  return {
    service,
    fetchedAt: new Date().toISOString(),
    httpRequestsTotal: httpTotal,
    avgLatencyMs: latency,

    ordersCreatedTotal: ordersCreated,
    ordersFailedTotal: ordersFailed,
    stockDecrementSuccessTotal: stockOk,
    stockDecrementFailTotal: stockFail,
    kitchenJobsProcessedTotal: kitchenOk,
    kitchenJobsFailedTotal: kitchenFail,

    rawText: text,
  };
}