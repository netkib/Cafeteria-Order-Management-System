import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { shortId } from "../../lib/utils";

export type OrderSummaryCardProps = {
  orderId: string;
  itemLabel?: string;
  quantity?: number;
  idempotencyKey?: string;
  connected?: boolean;
  onPrint?: () => void;
  canPrint?: boolean;
};

export function OrderSummaryCard({
  orderId,
  itemLabel,
  quantity,
  idempotencyKey,
  connected,
  onPrint,
  canPrint,
}: OrderSummaryCardProps) {
  const showPrint = typeof onPrint === "function";
  const enabled = canPrint ?? true;

  return (
    <Card className="lg:sticky lg:top-24">
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
        <CardDescription>Helpful for demo and debugging.</CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-bold text-slate-200">Order ID</div>
              <div className="mt-2 break-all text-sm text-slate-100">{orderId}</div>
              <div className="mt-1 text-xs text-slate-500">Short: {shortId(orderId, 14)}</div>
            </div>

            {showPrint ? (
              <Button variant="secondary" size="sm" onClick={onPrint} disabled={!enabled}>
                Print
              </Button>
            ) : null}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
            <div className="text-xs font-bold text-slate-200">Item</div>
            <div className="mt-2 text-sm text-slate-100">{itemLabel || "Unknown"}</div>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
            <div className="text-xs font-bold text-slate-200">Quantity</div>
            <div className="mt-2 text-sm text-slate-100">{quantity ?? "-"}</div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
          <div className="text-xs font-bold text-slate-200">Idempotency Key</div>
          <div className="mt-2 break-all text-xs text-slate-300">{idempotencyKey || "Not provided"}</div>
          <div className="mt-2 text-xs text-slate-500">Using the same key must not double-deduct stock.</div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
          <div className="flex items-center justify-between">
            <div className="text-xs font-bold text-slate-200">Live connection</div>
            <Badge tone={connected ? "success" : "warning"}>{connected ? "Connected" : "Disconnected"}</Badge>
          </div>
          <div className="mt-2 text-xs text-slate-400">If disconnected, use refresh fallback (not polling).</div>
        </div>
      </CardContent>
    </Card>
  );
}