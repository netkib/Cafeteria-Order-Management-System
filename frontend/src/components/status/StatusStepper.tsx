import { cn, statusDotClass, statusLabel } from "../../lib/utils";
import type { OrderStatus } from "../../types";

const FLOW: OrderStatus[] = ["PENDING", "STOCK_VERIFIED", "IN_KITCHEN", "READY"];

function idx(status: string) {
  const i = FLOW.indexOf(status as OrderStatus);
  return i >= 0 ? i : -1;
}

export type StatusStepperProps = {
  currentStatus: string;
  failed?: boolean;
};

export function StatusStepper({ currentStatus, failed }: StatusStepperProps) {
  const progress = idx(currentStatus);

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
      {FLOW.map((st, i) => {
        
        const done = progress >= i && progress !== -1 && !failed;
        const active = currentStatus === st;
        const dotTone = failed ? "FAILED" : active ? st : done ? "READY" : "PENDING";

        return (
          <div
            key={st}
            className={cn(
              "rounded-2xl border p-4",
              done
                ? "border-emerald-500/30 bg-emerald-500/10"
                : active
                ? "border-cyan-500/30 bg-cyan-500/10"
                : "border-slate-800 bg-slate-950/30"
            )}
          >
            <div className="flex items-center justify-between">
              <div className="text-xs font-extrabold text-slate-200">{statusLabel(st)}</div>
              <span className={cn("h-2.5 w-2.5 rounded-full", statusDotClass(dotTone))} />
            </div>
            <div className="mt-2 text-xs text-slate-400">
              {i === 0 && "Accepted by gateway"}
              {i === 1 && "Stock verified"}
              {i === 2 && "Being prepared"}
              {i === 3 && "Ready for pickup"}
            </div>
          </div>
        );
      })}
    </div>
  );
}