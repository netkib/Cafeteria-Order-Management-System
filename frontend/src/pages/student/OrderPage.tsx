import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Toast";
import { fetchItems, createOrder, getMe } from "../../lib/api";
import { clearToken, getToken, requireValidSession } from "../../lib/auth";
import { cn, getErrorMessage } from "../../lib/utils";
import type { ApiError, CreateOrderResponse, Item, ItemsResponse } from "../../types";

function isApiError(x: any): x is ApiError {
  return x && x.ok === false && x.error && typeof x.error.message === "string";
}

const LAST_ORDER_STORAGE_KEY_BASE = "prototype2.lastOrder";

type LastOrderStored = {
  idempotencyKey: string;
  orderId: string;
  itemId: string;
  quantity: number;
  savedAt?: string;
};

function storageKeyForStudent(studentId: string) {
  return `${LAST_ORDER_STORAGE_KEY_BASE}:${studentId}`;
}

export default function OrderPage() {
  const nav = useNavigate();
  const toast = useToast();
  const session = useMemo(() => requireValidSession(), []);
  const token = useMemo(() => getToken(), []);

  useEffect(() => {
    if (!session || !token) {
      nav("/student/login", { replace: true });
      return;
    }
    if (session.role !== "student") {
      nav("/admin", { replace: true });
    }
  }, [session, token, nav]);

  const studentId = session?.studentId ?? "";
  const [items, setItems] = useState<Item[]>([]);
  const [loadingItems, setLoadingItems] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string>("");
  const selectedItem = useMemo(
    () => items.find((i) => i.itemId === selectedItemId) ?? null,
    [items, selectedItemId]
  );
  const [quantity, setQuantity] = useState<number>(1);
  const [placing, setPlacing] = useState(false);
  const [balanceBdt, setBalanceBdt] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const priceBdt = useMemo(() => {
    const p = Number(selectedItem?.priceBdt);
    return Number.isFinite(p) && p >= 0 ? p : 0;
  }, [selectedItem?.priceBdt]);

  const totalCostBdt = useMemo(() => {
    const q = Number.isFinite(quantity) ? quantity : 1;
    return Math.max(0, Math.floor(priceBdt * q));
  }, [priceBdt, quantity]);

  const insufficientFunds = useMemo(() => {
    if (balanceBdt === null) return false;
    return totalCostBdt > balanceBdt;
  }, [balanceBdt, totalCostBdt]);

  const [lastIdemKey, setLastIdemKey] = useState<string | null>(null);
  const [lastOrderId, setLastOrderId] = useState<string | null>(null);
  const [lastPayload, setLastPayload] = useState<{ itemId: string; quantity: number } | null>(null);

  function saveLastOrderForStudent(
    sid: string,
    data: { idempotencyKey: string; orderId: string; itemId: string; quantity: number }
  ) {
    try {
      const payload: LastOrderStored = { ...data, savedAt: new Date().toISOString() };
      localStorage.setItem(storageKeyForStudent(sid), JSON.stringify(payload));
    } catch {}
  }

  function loadLastOrderForStudent(sid: string): LastOrderStored | null {
    try {
      const raw = localStorage.getItem(storageKeyForStudent(sid));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LastOrderStored;
      if (!parsed?.idempotencyKey || !parsed?.orderId || !parsed?.itemId) return null;
      if (typeof parsed.quantity !== "number") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    if (!studentId) {
      setLastIdemKey(null);
      setLastOrderId(null);
      setLastPayload(null);
      return;
    }
    setLastIdemKey(null);
    setLastOrderId(null);
    setLastPayload(null);

    const last = loadLastOrderForStudent(studentId);
    if (!last) return;

    setLastIdemKey(last.idempotencyKey);
    setLastOrderId(last.orderId);
    setLastPayload({ itemId: last.itemId, quantity: last.quantity });
    setSelectedItemId((prev) => (prev ? prev : last.itemId));
    setQuantity((prev) => (prev ? prev : last.quantity));

  }, [studentId]);

  function clampQty(n: number) {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(10, Math.floor(n)));
  }

  async function refreshBalance() {
    if (!token) {
      setBalanceBdt(null);
      return;
    }
    setLoadingBalance(true);
    try {
      const res = await getMe(token);
      if ((res as any)?.ok === true) {
        const b = Number((res as any).balanceBdt);
        setBalanceBdt(Number.isFinite(b) ? b : 0);
      } else {
        setBalanceBdt(null);
      }
    } catch {
      setBalanceBdt(null);
    } finally {
      setLoadingBalance(false);
    }
  }

  async function loadItems() {
    setLoadingItems(true);
    setItemsError(null);
    try {
      const res: ItemsResponse = await fetchItems();

      if (isApiError(res)) {
        setItemsError(res.error.message ?? "Failed to load items");
        setItems([]);
        return;
      }

      setItems(res.items);

      if (!selectedItemId && res.items.length > 0) {
        setSelectedItemId(res.items[0].itemId);
      }
    } catch (err) {
      setItemsError(getErrorMessage(err, "Failed to load items"));
      setItems([]);
    } finally {
      setLoadingItems(false);
    }
  }

  useEffect(() => {
    loadItems().catch(() => {});
    refreshBalance().catch(() => {});
  }, []);

  async function submitOrder(args: { itemId: string; qty: number; idempotencyKey: string }) {
    if (!session || !token) return;

    setPlacing(true);
    try {
      const res: CreateOrderResponse = await createOrder({
        token,
        itemId: args.itemId,
        quantity: args.qty,
        idempotencyKey: args.idempotencyKey,
      });

      if (isApiError(res)) {
        const code = res.error.code ?? "ERROR";
        const msg = res.error.message ?? "Order failed";

        if (code === "UNAUTHORIZED" || code === "HTTP_401") {
          clearToken();
          toast.push({ tone: "danger", title: "Session expired", message: "Please login again." });
          nav("/student/login", { replace: true });
          return;
        }

        if (code === "OUT_OF_STOCK") {
          toast.push({ tone: "warning", title: "Out of stock", message: msg });
          loadItems().catch(() => {});
          return;
        }

        if (code === "INSUFFICIENT_FUNDS") {
          toast.push({ tone: "warning", title: "Insufficient funds", message: msg });
          refreshBalance().catch(() => {});
          return;
        }

        toast.push({ tone: "danger", title: "Order failed", message: `${msg} (${code})` });
        return;
      }

      setLastIdemKey(args.idempotencyKey);
      setLastOrderId(res.orderId);
      setLastPayload({ itemId: args.itemId, quantity: args.qty });

      if (studentId) {
        saveLastOrderForStudent(studentId, {
          idempotencyKey: args.idempotencyKey,
          orderId: res.orderId,
          itemId: args.itemId,
          quantity: args.qty,
        });
      }

      toast.push({
        tone: "success",
        title: "Order accepted",
        message: "Redirecting to live status...",
        durationMs: 1800,
      });

      refreshBalance().catch(() => {});

      nav(`/student/status/${res.orderId}`, {
        replace: true,
        state: {
          orderId: res.orderId,
          itemId: args.itemId,
          itemName: items.find((i) => i.itemId === args.itemId)?.name ?? args.itemId,
          quantity: args.qty,
          idempotencyKey: args.idempotencyKey,
        },
      });
    } catch (err) {
      toast.push({
        tone: "danger",
        title: "Network error",
        message: getErrorMessage(err, "Could not place order. Try again."),
      });
    } finally {
      setPlacing(false);
    }
  }

  async function placeOrder() {
    if (!session || !token) return;

    const itemId = selectedItemId.trim();
    const qty = clampQty(quantity);

    if (!itemId) {
      toast.push({ tone: "warning", title: "Select item", message: "Please select an item first." });
      return;
    }
    if (!selectedItem) {
      toast.push({ tone: "warning", title: "Invalid item", message: "Try selecting the item again." });
      return;
    }
    if (selectedItem.quantity <= 0) {
      toast.push({
        tone: "warning",
        title: "Out of stock",
        message: "This item shows 0 in stock. Please choose another.",
      });
      return;
    }
    if (balanceBdt !== null && totalCostBdt > balanceBdt) {
      toast.push({
        tone: "warning",
        title: "Insufficient funds",
        message: `You need BDT ${totalCostBdt}, but you have BDT ${balanceBdt}.`,
      });
      return;
    }

    const idempotencyKey = uuidv4();
    await submitOrder({ itemId, qty, idempotencyKey });
  }

  async function retryLastOrder() {
    if (!lastIdemKey || !lastPayload) return;

    setSelectedItemId(lastPayload.itemId);
    setQuantity(lastPayload.quantity);

    await submitOrder({
      itemId: lastPayload.itemId,
      qty: lastPayload.quantity,
      idempotencyKey: lastIdemKey,
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* left */}
      <div className="lg:col-span-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-1 text-xs font-semibold text-slate-200">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              Menu + Stock (from Stock Service)
            </div>

            <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">Choose your item</h1>

            <p className="mt-1 text-sm text-slate-300">
              Stock shown here comes from the inventory service. If it hits 0, the gateway will reject orders quickly
              using cache-first protection.
            </p>
          </div>

          <div className="flex gap-2">
            <Button variant="secondary" onClick={loadItems} disabled={loadingItems}>
              {loadingItems ? "Refreshing..." : "Refresh stock"}
            </Button>
          </div>
        </div>

        <div className="mt-5">
          {itemsError ? (
            <Card>
              <CardContent className="py-6">
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
                  {itemsError}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {loadingItems ? (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl border border-slate-800 bg-slate-950/30" />
              ))}
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {items.map((it) => {
                const isSelected = it.itemId === selectedItemId;
                const out = it.quantity <= 0;
                const p = Number(it.priceBdt);
                const price = Number.isFinite(p) ? p : 0;

                return (
                  <button
                    key={it.itemId}
                    onClick={() => setSelectedItemId(it.itemId)}
                    className={cn(
                      "rounded-2xl border p-4 text-left transition",
                      "focus:outline-none focus:ring-2 focus:ring-cyan-400/30",
                      isSelected
                        ? "border-cyan-500/40 bg-cyan-500/10"
                        : "border-slate-800 bg-slate-950/30 hover:bg-slate-800/40"
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-extrabold text-slate-100">{it.name}</div>
                        <div className="mt-1 text-xs text-slate-400">ID: {it.itemId}</div>
                        <div className="mt-2 text-xs text-slate-300">
                          Price: <span className="font-extrabold text-slate-100">BDT {price}</span>
                        </div>
                      </div>

                      <Badge tone={out ? "danger" : it.quantity <= 3 ? "warning" : "success"}>
                        {out ? "OUT" : `${it.quantity} left`}
                      </Badge>
                    </div>

                    {Array.isArray(it.details) && it.details.length > 0 ? (
                      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-300">
                        {it.details.slice(0, 5).map((d, idx) => (
                          <li key={`${it.itemId}-d-${idx}`}>{d}</li>
                        ))}
                      </ul>
                    ) : (
                      <div className="mt-3 text-xs text-slate-300">
                        {out ? "This item is currently unavailable." : "Tap to select and place your order."}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* right*/}
      <div className="lg:col-span-4">
        <Card className="lg:sticky lg:top-24">
          <CardHeader>
            <CardTitle>Quick order</CardTitle>
            <CardDescription>
              Your request goes through JWT auth and stock verification, then enters the async kitchen queue.
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-extrabold text-slate-200">Your balance</div>
                <Badge tone={insufficientFunds ? "warning" : "success"}>{loadingBalance ? "LOADING" : "BDT"}</Badge>
              </div>
              <div className="mt-2 text-lg font-black text-slate-100">{loadingBalance ? "…" : balanceBdt ?? "—"}</div>
              <div className="mt-3">
                <Button variant="ghost" size="sm" className="w-full" onClick={() => refreshBalance().catch(() => {})}>
                  Refresh balance
                </Button>
              </div>
            </div>

            <Input
              label="Quantity (1-10)"
              type="number"
              inputMode="numeric"
              min={1}
              max={10}
              value={String(quantity)}
              onChange={(e) => setQuantity(clampQty(Number(e.target.value)))}
              hint="Keeping this small helps the demo under load."
            />

            <Button
              className="w-full"
              loading={placing}
              onClick={placeOrder}
              disabled={!selectedItem || selectedItem.quantity <= 0 || placing || insufficientFunds}
            >
              {placing ? "Placing order..." : "Place order"}
            </Button>

            {/* idempotency */}
            <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
              <div className="flex items-center justify-between">
                <div className="text-xs font-extrabold text-slate-200">Idempotency demo</div>
                <Badge tone="info">RETRY SAFE</Badge>
              </div>

              <div className="mt-2 text-xs text-slate-400">
                This will retry the <span className="font-bold text-slate-200">last successful order</span> for{" "}
                <span className="font-bold text-slate-200">{studentId || "this student"}</span> using the same
                Idempotency-Key (so balance/stock will not be deducted twice).
              </div>

              <div className="mt-3 space-y-2 text-xs">
                <div className="text-slate-300">
                  Last Idempotency-Key:
                  <div className="mt-1 break-all rounded-xl border border-slate-800 bg-slate-950/40 px-2 py-2 text-slate-200">
                    {lastIdemKey ?? "None yet"}
                  </div>
                </div>

                <div className="text-slate-300">
                  Last Order ID:
                  <div className="mt-1 break-all rounded-xl border border-slate-800 bg-slate-950/40 px-2 py-2 text-slate-200">
                    {lastOrderId ?? "None yet"}
                  </div>
                </div>

                {lastPayload ? (
                  <div className="text-slate-400">
                    Will retry: <span className="font-semibold text-slate-200">{lastPayload.itemId}</span> ×{" "}
                    <span className="font-semibold text-slate-200">{lastPayload.quantity}</span>
                  </div>
                ) : null}
              </div>

              <div className="mt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full"
                  disabled={!lastIdemKey || placing || !lastPayload}
                  onClick={retryLastOrder}
                >
                  Retry last order with same key
                </Button>
              </div>
            </div>

            <div className="text-xs text-slate-500">
              Next page shows live updates: STOCK_VERIFIED then IN_KITCHEN then READY (no polling).
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}