import { Button } from "../ui/Button";
import { Badge } from "../ui/Badge";
import { cn, formatTime } from "../../lib/utils";
import type { ServiceName } from "../../types";

export type ServiceHealthCardProps = {
  name: ServiceName;
  baseUrl: string;
  ok: boolean;
  lastCheckedAt?: string;
  onKill?: () => void;
  killing?: boolean;
};

export function ServiceHealthCard({
  name,
  baseUrl,
  ok,
  lastCheckedAt,
  onKill,
  killing,
}: ServiceHealthCardProps) {
  return (
    <div
      className={cn(
        "rounded-2xl border p-4",
        ok ? "border-emerald-500/30 bg-emerald-500/10" : "border-rose-500/30 bg-rose-500/10"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-extrabold text-slate-100">{name.toUpperCase()}</div>
          <div className="mt-1 break-all text-xs text-slate-300">{baseUrl}</div>
        </div>
        <Badge tone={ok ? "success" : "danger"}>{ok ? "HEALTHY" : "DOWN"}</Badge>
      </div>

      <div className="mt-3 text-xs text-slate-300">
        Last checked:{" "}
        <span className="font-semibold text-slate-100">{lastCheckedAt ? formatTime(lastCheckedAt) : "..."}</span>
      </div>

      {onKill ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="danger"
            className="w-full"
            onClick={onKill}
            loading={!!killing}
          >
            Kill service
          </Button>
        </div>
      ) : null}
    </div>
  );
}