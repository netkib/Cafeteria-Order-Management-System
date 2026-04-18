import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Toast";
import { fetchItems, getOrder } from "../../lib/api";
import { clearToken, getToken, requireValidSession } from "../../lib/auth";
import {
  connectSocket,
  disconnectSocket,
  onOrderStatus,
  subscribeToOrder,
  unsubscribeFromOrder,
} from "../../lib/socket";
import {
  cn,
  formatTime,
  getErrorMessage,
  shortId,
  statusBadgeClass,
  statusDotClass,
  statusLabel,
} from "../../lib/utils";
import type { ApiError, OrderStatus, OrderStatusEvent } from "../../types";
import { printHtmlToken } from "../../lib/print";

function isApiError(x: any): x is ApiError {
  return x && x.ok === false && x.error && typeof x.error.message === "string";
}

const ORDER_FLOW: OrderStatus[] = ["PENDING", "STOCK_VERIFIED", "IN_KITCHEN", "READY"];

function isOrderStatus(x: any): x is OrderStatus {
  return ORDER_FLOW.includes(x as OrderStatus) || x === "FAILED";
}

type LocationState = {
  itemId?: string;
  itemName?: string;
  quantity?: number;
  idempotencyKey?: string;
};

function flowIndex(status: string): number {
  const idx = ORDER_FLOW.indexOf(status as OrderStatus);
  return idx >= 0 ? idx : -1;
}

export default function LiveStatusPage() {
  const nav = useNavigate();
  const toast = useToast();
  const params = useParams();
  const loc = useLocation();
  const orderId = String(params.orderId ?? "").trim();
  const state = (loc.state ?? {}) as LocationState;
  const session = useMemo(() => requireValidSession(), []);
  const token = useMemo(() => getToken(), []);
  const [connected, setConnected] = useState(false);
  const [currentStatus, setCurrentStatus] = useState<string>("PENDING");
  const [events, setEvents] = useState<OrderStatusEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [itemId, setItemId] = useState<string>(state.itemId ?? "");
  const [qty, setQty] = useState<number>(state.quantity ?? 1);
  const itemNameFromState = state.itemName ?? "";
  const idemKey = state.idempotencyKey ?? "";
  const [resolvedItemName, setResolvedItemName] = useState<string>(itemNameFromState);
  const [details, setDetails] = useState<string[]>([]);
  const [priceBdt, setPriceBdt] = useState<number>(0);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!orderId) {
      nav("/student/order", { replace: true });
      return;
    }
    if (!session || !token) {
      nav("/student/login", { replace: true });
      return;
    }
    if (session.role !== "student") {
      nav("/admin", { replace: true });
      return;
    }
  }, [orderId, session, token, nav]);

  function mergeEvent(evt: OrderStatusEvent) {
    if (!isOrderStatus(evt.status)) return;

    setEvents((prev) => {
      const key = `${evt.status}|${evt.at ?? ""}|${evt.source ?? ""}`;
      const seen = new Set(prev.map((p) => `${p.status}|${p.at ?? ""}|${p.source ?? ""}`));
      if (seen.has(key)) return prev;

      const next = [...prev, evt];
      next.sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return ta - tb;
      });
      return next.slice(-50);
    });

    setCurrentStatus(evt.status);
  }

  async function hydrateTokenMeta(bestItemId: string) {
    try {
      const res = await fetchItems();
      if (isApiError(res)) return;

      const found = res.items.find((x: any) => x?.itemId === bestItemId);
      if (!found) return;

      const nm = String(found?.name ?? "").trim();
      if (nm) setResolvedItemName(nm);

      const p = Number(found?.priceBdt);
      setPriceBdt(Number.isFinite(p) && p >= 0 ? p : 0);

      const d = Array.isArray(found?.details) ? found.details.filter(Boolean) : [];
      setDetails(d);
    } catch {}
  }

  async function initialFetchOnce() {
    if (!token || !orderId) return;
    setLoading(true);

    try {
      const res = await getOrder(token, orderId);

      if (isApiError(res)) {
        if (res.error.code === "UNAUTHORIZED" || res.error.code === "HTTP_401") {
          clearToken();
          toast.push({ tone: "danger", title: "Session expired", message: "Please login again." });
          nav("/student/login", { replace: true });
          return;
        }

        toast.push({ tone: "warning", title: "Could not load order", message: res.error.message });
        return;
      }

      const st = String((res as any).status ?? "PENDING");
      if (isOrderStatus(st)) setCurrentStatus(st);

      const rawEvents = (res as any).events ?? [];
      const timeline: OrderStatusEvent[] = [];

      for (const e of rawEvents) {
        const es = e?.status;
        if (!isOrderStatus(es)) continue;

        timeline.push({
          orderId,
          studentId: session?.studentId ?? "student",
          status: es as OrderStatus,
          message: e?.message ?? null,
          at: typeof e?.at === "string" ? e.at : undefined,
          source: "gateway",
        });
      }

      if (timeline.length > 0) setEvents(timeline);
      const bestItemId = String(itemId || (res as any).itemId || "").trim();
      if (!itemId && (res as any).itemId) setItemId(String((res as any).itemId));
      if (!qty && typeof (res as any).quantity === "number") setQty((res as any).quantity);
      if (bestItemId) {
        hydrateTokenMeta(bestItemId).catch(() => {});
      }
    } catch (err) {
      toast.push({
        tone: "danger",
        title: "Network error",
        message: getErrorMessage(err, "Failed to load order."),
      });
    } finally {
      setLoading(false);
    }
  }

  async function manualRefresh() {
    toast.push({ tone: "info", title: "Refreshing", message: "Fetching latest order state..." });
    await initialFetchOnce();
  }

  useEffect(() => {
    if (!token || !orderId) return;

    initialFetchOnce().catch(() => {});

    connectSocket(token);
    subscribeToOrder(orderId);

    const cleanup = onOrderStatus({
      onConnectChange: (isConn) => {
        setConnected(isConn);
        if (isConn) {
          toast.push({
            tone: "success",
            title: "Live connected",
            message: "Receiving real-time updates (no polling).",
            durationMs: 1800,
          });
        } else {
          toast.push({
            tone: "warning",
            title: "Disconnected",
            message: "Live updates paused. Use Refresh as fallback.",
            durationMs: 2200,
          });
        }
      },
      onError: (message) => {
        toast.push({ tone: "danger", title: "Live connection error", message });
      },
      onStatus: (evt) => {
        if (evt.orderId !== orderId) return;
        mergeEvent(evt as any);
      },
    });

    cleanupRef.current = cleanup;

    return () => {
      try {
        cleanup();
      } catch {}
      cleanupRef.current = null;
      unsubscribeFromOrder(orderId);
    };
  }, [token, orderId]);

  const progress = flowIndex(currentStatus);
  const isFailed = currentStatus === "FAILED";
  const isReady = currentStatus === "READY";

  function printToken() {
    const safeOrderId = orderId || "UNKNOWN_ORDER";
    const safeIdem = idemKey || "N/A";
    const safeName = resolvedItemName || itemNameFromState || itemId || "Unknown item";
    const safeQty = Number.isFinite(qty) ? qty : 1;
    const safePrice = Number.isFinite(priceBdt) ? priceBdt : 0;
    const total = Math.max(0, Math.floor(safePrice * safeQty));
    const safeDetails = Array.isArray(details) ? details : [];

    const detailsHtml =
      safeDetails.length > 0
        ? `<ul style="margin:8px 0 0 0; padding-left:18px;">${safeDetails
            .map((d) => `<li style="margin:2px 0;">${escapeHtml(String(d))}</li>`)
            .join("")}</ul>`
        : `<div class="small" style="margin-top:8px;">(No details)</div>`;

    const tokenInner = `
      <div class="title">CAFETERIA TOKEN</div>
      <div class="small">Time: ${escapeHtml(new Date().toLocaleString())}</div>
      <div class="base"><span class="strong">Order ID:</span> <span class="mono">${escapeHtml(safeOrderId)}</span></div>
      <div class="base"><span class="strong">Idempotency:</span> <span class="mono">${escapeHtml(safeIdem)}</span></div>
      <div class="hr"></div>
      <div class="base strong">${escapeHtml(safeName)}</div>
      ${detailsHtml}
      <div class="hr"></div>
      <div class="base"><span class="strong">Quantity:</span> ${escapeHtml(String(safeQty))}</div>
      <div class="base"><span class="strong">Price:</span> BDT ${escapeHtml(String(safePrice))}</div>
      <div class="base"><span class="strong">Total:</span> BDT ${escapeHtml(String(total))}</div>
    `;

    const ok = printHtmlToken(tokenInner, { title: "Order Token" });
    if (!ok) {
      toast.push({ tone: "danger", title: "Print failed", message: "Could not open print view." });
    }
  }

  function escapeHtml(s: string) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left: main status */}
      <div className="lg:col-span-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-1 text-xs font-semibold text-slate-200">
              <span className={cn("h-2 w-2 rounded-full", connected ? "bg-emerald-400" : "bg-amber-400")} />
              Live Status (WebSocket)
            </div>
            <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">Order Tracker</h1>
            <p className="mt-1 text-sm text-slate-300">
              Updates are pushed in real-time from the Notification Hub. No polling is required.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => nav("/student/order")}>
              New order
            </Button>
            <Button variant="ghost" onClick={manualRefresh}>
              Refresh (fallback)
            </Button>
          </div>
        </div>

        <Card className="mt-5">
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  Current status
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold",
                      statusBadgeClass(currentStatus)
                    )}
                  >
                    {statusLabel(currentStatus)}
                  </span>
                </CardTitle>

                <CardDescription className="flex flex-wrap items-center gap-2">
                  <span>
                    Order ID: <span className="font-semibold text-slate-200">{shortId(orderId, 14)}</span>
                  </span>
                  <Button variant="secondary" size="sm" onClick={printToken}>
                    Print token
                  </Button>
                </CardDescription>
              </div>

              <div className="flex items-center gap-2">
                <Badge tone={connected ? "success" : "warning"}>{connected ? "LIVE" : "OFFLINE"}</Badge>
                {isReady ? <Badge tone="success">PICKUP</Badge> : null}
                {isFailed ? <Badge tone="danger">FAILED</Badge> : null}
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
              {ORDER_FLOW.map((st, idx) => {
                const done = progress >= idx && progress !== -1 && !isFailed;
                const active = currentStatus === st;
                const dotTone = isFailed ? "FAILED" : active ? st : done ? "READY" : "PENDING";

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
                      {idx === 0 && "Accepted by gateway"}
                      {idx === 1 && "Stock verified"}
                      {idx === 2 && "Being prepared"}
                      {idx === 3 && "Ready for pickup"}
                    </div>
                  </div>
                );
              })}
            </div>

            {isFailed ? (
              <div className="mt-4 rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">
                The order failed. Check Admin dashboard health/metrics or place a new order.
              </div>
            ) : null}

            {isReady ? (
              <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                Your order is ready. Please pick it up from the counter.
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* timeline */}
        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Event timeline</CardTitle>
            <CardDescription>History of state changes (live).</CardDescription>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="text-sm text-slate-400">Loading timeline...</div>
            ) : events.length === 0 ? (
              <div className="text-sm text-slate-400">
                No events yet. If live is offline, use Refresh once.
              </div>
            ) : (
              <div className="space-y-3">
                {events.map((e, i) => (
                  <div
                    key={`${e.status}-${e.at ?? ""}-${i}`}
                    className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold",
                          statusBadgeClass(e.status)
                        )}
                      >
                        {statusLabel(e.status)}
                      </span>
                      {e.source ? <Badge tone="neutral">{String(e.source)}</Badge> : null}
                    </div>

                    <div className="mt-2 text-sm text-slate-200">{e.message ?? "Status update received"}</div>
                    <div className="mt-1 text-xs text-slate-500">{formatTime(e.at ?? "")}</div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* right side*/}
      <div className="lg:col-span-4">
        <Card className="lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle>Order summary</CardTitle>
            <CardDescription>Helpful for demo and debugging.</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-bold text-slate-200">Order ID</div>
                  <div className="mt-2 break-all text-sm text-slate-100">{orderId}</div>
                </div>
                <Button variant="secondary" size="sm" onClick={printToken}>
                  Print
                </Button>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                <div className="text-xs font-bold text-slate-200">Item</div>
                <div className="mt-2 text-sm text-slate-100">
                  {resolvedItemName || itemNameFromState || itemId || "Unknown"}
                </div>

                {details.length > 0 ? (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-300">
                    {details.slice(0, 8).map((d, idx) => (
                      <li key={`d-${idx}`} className="leading-snug">
                        {d}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>

              <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                <div className="text-xs font-bold text-slate-200">Quantity</div>
                <div className="mt-2 text-sm text-slate-100">{qty}</div>

                <div className="mt-2 text-xs text-slate-400">
                  Price: <span className="font-semibold text-slate-200">BDT {priceBdt}</span> • Total:{" "}
                  <span className="font-semibold text-slate-200">BDT {Math.max(0, Math.floor(priceBdt * qty))}</span>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="text-xs font-bold text-slate-200">Idempotency Key</div>
              <div className="mt-2 break-all text-xs text-slate-300">{idemKey || "Not provided"}</div>
              <div className="mt-2 text-xs text-slate-500">
                Retry-safe ordering: using the same key must not double-deduct stock.
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-bold text-slate-200">Live connection</div>
                <Badge tone={connected ? "success" : "warning"}>{connected ? "Connected" : "Disconnected"}</Badge>
              </div>

              <div className="mt-2 text-xs text-slate-400">
                If disconnected, use Refresh once (fallback). This is not polling.
              </div>

              <div className="mt-3 flex gap-2">
                <Button variant="secondary" size="sm" className="w-full" onClick={manualRefresh}>
                  Refresh
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    try {
                      disconnectSocket();
                    } catch {}
                    if (token) connectSocket(token);
                    subscribeToOrder(orderId);
                    toast.push({ tone: "info", title: "Reconnecting", message: "Attempting to rejoin live updates..." });
                  }}
                >
                  Reconnect
                </Button>
              </div>
            </div>

            <Button variant="danger" className="w-full" onClick={() => nav("/admin")}>
              Go to Admin dashboard
            </Button>

            <div className="text-xs text-slate-500">
              Admin dashboard shows service health, live metrics, and chaos kill toggles.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}