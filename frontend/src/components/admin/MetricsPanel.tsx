import { Badge } from "../ui/Badge";
import { formatTime } from "../../lib/utils";
import type { MetricsSnapshot, ServiceName } from "../../types";

export type MetricsPanelProps = {
  service: ServiceName;
  snapshot?: MetricsSnapshot | null;
  rps?: number;
};

export function MetricsPanel({ service, snapshot, rps }: MetricsPanelProps) {
  const avgLatency = snapshot?.avgLatencyMs;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-extrabold text-slate-100">{service.toUpperCase()}</div>
          <div className="mt-1 text-xs text-slate-400">
            Updated: {snapshot?.fetchedAt ? formatTime(snapshot.fetchedAt) : "..."}
          </div>
        </div>
        <Badge tone="info">METRICS</Badge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-xs text-slate-400">Avg latency</div>
          <div className="mt-1 text-lg font-black">
            {typeof avgLatency === "number" ? `${Math.round(avgLatency)}ms` : "..."}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-xs text-slate-400">Throughput</div>
          <div className="mt-1 text-lg font-black">{typeof rps === "number" ? `${rps.toFixed(2)} rps` : "..."}</div>
        </div>
      </div>

      <div className="mt-3 text-xs text-slate-400">
        Total requests:{" "}
        <span className="font-semibold text-slate-200">
          {typeof snapshot?.httpRequestsTotal === "number" ? snapshot.httpRequestsTotal : "..."}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {typeof snapshot?.ordersCreatedTotal === "number" ? (
          <Badge tone="neutral">orders_created: {snapshot.ordersCreatedTotal}</Badge>
        ) : null}
        {typeof snapshot?.ordersFailedTotal === "number" ? (
          <Badge tone="danger">orders_failed: {snapshot.ordersFailedTotal}</Badge>
        ) : null}
        {typeof snapshot?.stockDecrementSuccessTotal === "number" ? (
          <Badge tone="neutral">stock_ok: {snapshot.stockDecrementSuccessTotal}</Badge>
        ) : null}
        {typeof snapshot?.stockDecrementFailTotal === "number" ? (
          <Badge tone="danger">stock_fail: {snapshot.stockDecrementFailTotal}</Badge>
        ) : null}
        {typeof snapshot?.kitchenJobsProcessedTotal === "number" ? (
          <Badge tone="neutral">kitchen_ok: {snapshot.kitchenJobsProcessedTotal}</Badge>
        ) : null}
        {typeof snapshot?.kitchenJobsFailedTotal === "number" ? (
          <Badge tone="danger">kitchen_fail: {snapshot.kitchenJobsFailedTotal}</Badge>
        ) : null}
      </div>
    </div>
  );
}