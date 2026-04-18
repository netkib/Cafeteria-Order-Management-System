import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { v4 as uuidv4 } from "uuid";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Toast";
import { config } from "../../lib/config";
import {
  adminKillService,
  adminUpsertItem,
  getHealth,
  getMetricsText,
  walletRechargeAdmin,
  adminListStudents,
  adminCreateStudent,
  adminDeleteStudent,
  adminListItems,
  adminDeleteItem,
  adminListOrders,
} from "../../lib/api";
import { requireValidSession } from "../../lib/auth";
import { buildSnapshot, computeRps } from "../../lib/metrics";
import { cn, formatTime, getErrorMessage } from "../../lib/utils";
import type {
  ApiError,
  MetricsSnapshot,
  ServiceName,
  AdminStudentRow,
  AdminInventoryRow,
  AdminOrderRow,
} from "../../types";

function isApiError(x: any): x is ApiError {
  return x && x.ok === false && x.error && typeof x.error.message === "string";
}

function truncateTo(value: string, keep = 16) {
  const s = String(value ?? "");
  if (s.length <= keep) return s;
  return s.slice(0, keep) + "...";
}

async function copyToClipboard(text: string) {
  const s = String(text ?? "");
  if (!s) return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch {}

  try {
    const el = document.createElement("textarea");
    el.value = s;
    el.style.position = "fixed";
    el.style.left = "-9999px";
    el.style.top = "0";
    el.setAttribute("readonly", "true");
    document.body.appendChild(el);
    el.focus();
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

type ServiceRow = { name: ServiceName; baseUrl: string };

const SERVICES: ServiceRow[] = [
  { name: "identity", baseUrl: config.services.identity },
  { name: "gateway", baseUrl: config.services.gateway },
  { name: "stock", baseUrl: config.services.stock },
  { name: "kitchen", baseUrl: config.services.kitchen },
  { name: "notification", baseUrl: config.services.notification },
];

type HealthState = {
  ok: boolean;
  lastCheckedAt: string;
  details?: any;
};

type MetricsState = {
  snapshot: MetricsSnapshot;
  rps?: number;
};

const ADMIN_SECRET_STORAGE_KEY = "prototype2.adminSecret";

export default function AdminDashboardPage() {
  const nav = useNavigate();
  const toast = useToast();
  const session = useMemo(() => requireValidSession(), []);

  useEffect(() => {
    if (!session) {
      nav("/student/login", { replace: true });
      return;
    }
    if (session.role !== "admin") {
      nav("/student/order", { replace: true });
    }
  }, [session, nav]);

  const [adminSecret, setAdminSecret] = useState<string>(() => {
    try {
      return localStorage.getItem(ADMIN_SECRET_STORAGE_KEY) ?? "dev_admin_secret_change_me";
    } catch {
      return "dev_admin_secret_change_me";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(ADMIN_SECRET_STORAGE_KEY, adminSecret);
    } catch {}
  }, [adminSecret]);

  // Health state per service
  const [healthMap, setHealthMap] = useState<Record<ServiceName, HealthState | null>>({
    identity: null,
    gateway: null,
    stock: null,
    kitchen: null,
    notification: null,
  });

  // Metrics state per service
  const [metricsMap, setMetricsMap] = useState<Record<ServiceName, MetricsState | null>>({
    identity: null,
    gateway: null,
    stock: null,
    kitchen: null,
    notification: null,
  });

  const prevTotalsRef = useRef<Record<ServiceName, { total?: number; at: number }>>({
    identity: { at: Date.now() },
    gateway: { at: Date.now() },
    stock: { at: Date.now() },
    kitchen: { at: Date.now() },
    notification: { at: Date.now() },
  });

  const gatewayLatencyWindowRef = useRef<Array<{ at: number; latencyMs: number }>>([]);
  const [gatewayLatencyAlert, setGatewayLatencyAlert] = useState<{ avg30sMs: number; triggered: boolean } | null>(
    null
  );

  const [loadingHealth, setLoadingHealth] = useState(false);
  const [loadingMetrics, setLoadingMetrics] = useState(false);
  const [killingService, setKillingService] = useState<ServiceName | null>(null);

  const overallOk = Object.values(healthMap)
    .filter((v) => v !== null)
    .every((v) => v?.ok === true);

  const [rechargeStudentId, setRechargeStudentId] = useState("student1");
  const [rechargeAmount, setRechargeAmount] = useState<number>(100);
  const [rechargeIdemKey, setRechargeIdemKey] = useState<string>(() => uuidv4());
  const [recharging, setRecharging] = useState(false);
  const [itemId, setItemId] = useState("ITEM04");
  const [itemQty, setItemQty] = useState<number>(10);
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState<number>(0);
  const [itemDetailsText, setItemDetailsText] = useState("- 3 dates\n- 1 juice\n- 1 biriyani");
  const [upsertingItem, setUpsertingItem] = useState(false);
  const [studentsLoading, setStudentsLoading] = useState(false);
  const [students, setStudents] = useState<AdminStudentRow[]>([]);
  const [studentCreateId, setStudentCreateId] = useState("student3");
  const [studentCreateName, setStudentCreateName] = useState("New Student");
  const [studentCreatePass, setStudentCreatePass] = useState("password123");
  const [studentCreateBalance, setStudentCreateBalance] = useState<number>(200);
  const [creatingStudent, setCreatingStudent] = useState(false);
  const [deletingStudentId, setDeletingStudentId] = useState<string | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventory, setInventory] = useState<AdminInventoryRow[]>([]);
  const [deletingItemId, setDeletingItemId] = useState<string | null>(null);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orders, setOrders] = useState<AdminOrderRow[]>([]);
  const [ordersStudentFilter, setOrdersStudentFilter] = useState("");
  const [ordersStatusFilter, setOrdersStatusFilter] = useState("");
  const [ordersLimit, setOrdersLimit] = useState<number>(50);

  function clampAmount(n: number) {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(100000, Math.floor(n)));
  }

  function clampQty(n: number) {
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(100000, Math.floor(n)));
  }

  function clampLimit(n: number) {
    if (!Number.isFinite(n)) return 50;
    return Math.max(1, Math.min(200, Math.floor(n)));
  }

  function parseDetails(text: string): string[] {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .map((line) => line.replace(/^[-•\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 30);
  }

  function ensureAdminSecretOrToast(): string | null {
    const secret = adminSecret.trim();
    if (!secret) {
      toast.push({ tone: "warning", title: "Admin secret required", message: "Enter x-admin-secret first." });
      return null;
    }
    return secret;
  }
  async function handleCopy(label: string, value?: string) {
    const v = String(value ?? "").trim();
    if (!v) return;

    try {
      const ok = await copyToClipboard(v);
      if (!ok) {
        toast.push({ tone: "danger", title: "Copy failed", message: "Clipboard is not available in this context." });
        return;
      }
      toast.push({ tone: "success", title: "Copied", message: `${label} copied to clipboard.`, durationMs: 2000 });
    } catch (err) {
      toast.push({ tone: "danger", title: "Copy failed", message: getErrorMessage(err) });
    }
  }

  async function refreshHealth() {
    setLoadingHealth(true);
    try {
      const nowIso = new Date().toISOString();

      const results = await Promise.all(
        SERVICES.map(async (svc) => {
          try {
            const res = await getHealth(svc.baseUrl);
            if (isApiError(res)) {
              return { name: svc.name, state: { ok: false, lastCheckedAt: nowIso, details: res } as HealthState };
            }
            return {
              name: svc.name,
              state: { ok: !!(res as any).ok, lastCheckedAt: nowIso, details: res } as HealthState,
            };
          } catch (err) {
            return {
              name: svc.name,
              state: { ok: false, lastCheckedAt: nowIso, details: { error: getErrorMessage(err) } } as HealthState,
            };
          }
        })
      );

      setHealthMap((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.name] = r.state;
        return next;
      });
    } finally {
      setLoadingHealth(false);
    }
  }

  function updateGatewayLatencyAlert(latencyMs: number) {
    const arr = gatewayLatencyWindowRef.current;
    const now = Date.now();

    arr.push({ at: now, latencyMs });

    const cutoff = now - 30_000;

    while (arr.length > 0 && arr[0].at < cutoff) arr.shift();

    const avg30 = arr.reduce((sum, p) => sum + p.latencyMs, 0) / Math.max(1, arr.length);
    const triggered = avg30 > 1000;

    setGatewayLatencyAlert({ avg30sMs: avg30, triggered });

    if (triggered) {
      toast.push({
        tone: "warning",
        title: "Gateway latency alert",
        message: `Avg latency over ~30s is ${Math.round(avg30)}ms (over 1000ms).`,
        durationMs: 3500,
      });
    }
  }

  async function refreshMetrics() {
    setLoadingMetrics(true);
    try {
      const now = Date.now();
      const results = await Promise.all(
        SERVICES.map(async (svc) => {
          try {
            const metricsText = await getMetricsText(svc.baseUrl);

            if (isApiError(metricsText)) {
              return { name: svc.name, state: null as MetricsState | null };
            }

            const snapshot = buildSnapshot(svc.name, metricsText);
            const prev = prevTotalsRef.current[svc.name];
            const rps = computeRps(prev.total, snapshot.httpRequestsTotal, now - prev.at);

            prevTotalsRef.current[svc.name] = { total: snapshot.httpRequestsTotal, at: now };

            if (svc.name === "gateway" && typeof snapshot.avgLatencyMs === "number") {
              updateGatewayLatencyAlert(snapshot.avgLatencyMs);
            }
            return { name: svc.name, state: { snapshot, rps } as MetricsState };
          } catch {
            return { name: svc.name, state: null as MetricsState | null };
          }
        })
      );

      setMetricsMap((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.name] = r.state;
        return next;
      });
    } finally {
      setLoadingMetrics(false);
    }
  }

  async function killService(svc: ServiceRow) {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    setKillingService(svc.name);
    try {
      const res = await adminKillService({ serviceBaseUrl: svc.baseUrl, adminSecret: secret });

      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Chaos action failed", message: res.error.message });
        return;
      }

      toast.push({
        tone: "success",
        title: "Chaos triggered",
        message: `${svc.name.toUpperCase()} was killed. Watch health turn red.`,
        durationMs: 3000,
      });

      setTimeout(() => refreshHealth().catch(() => {}), 800);
    } catch (err) {
      toast.push({ tone: "danger", title: "Chaos action failed", message: getErrorMessage(err) });
    } finally {
      setKillingService(null);
    }
  }

  // Wallet recharge 
  async function doRecharge() {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    const studentId = rechargeStudentId.trim();
    const amountBdt = clampAmount(rechargeAmount);
    const idem = String(rechargeIdemKey || "").trim();

    if (!studentId) {
      toast.push({ tone: "warning", title: "Student required", message: "Enter a studentId." });
      return;
    }
    if (!idem) {
      toast.push({ tone: "warning", title: "Idempotency required", message: "Generate an idempotency key." });
      return;
    }

    setRecharging(true);
    try {
      const res = await walletRechargeAdmin({
        adminSecret: secret,
        studentId,
        amountBdt,
        idempotencyKey: idem,
      });

      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Recharge failed", message: `${res.error.message} (${res.error.code})` });
        return;
      }

      toast.push({
        tone: "success",
        title: "Recharge completed",
        message: `Updated balance for ${res.studentId} is now BDT ${res.balanceBdt}.`,
        durationMs: 3500,
      });

      refreshStudents().catch(() => {});
    } catch (err) {
      toast.push({ tone: "danger", title: "Recharge failed", message: getErrorMessage(err) });
    } finally {
      setRecharging(false);
    }
  }

  async function doUpsertItem() {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    const id = itemId.trim();
    const qty = clampQty(itemQty);

    if (!id) {
      toast.push({ tone: "warning", title: "Item ID required", message: "Enter an itemId (e.g., ITEM04)." });
      return;
    }

    const detailsArr = parseDetails(itemDetailsText);
    const wantsMeta = Boolean(itemName.trim()) || Number(itemPrice) > 0 || detailsArr.length > 0;

    if (wantsMeta) {
      if (!itemName.trim()) {
        toast.push({ tone: "warning", title: "Name required", message: "For new items, name is required." });
        return;
      }
      if (!Number.isFinite(itemPrice) || itemPrice <= 0) {
        toast.push({ tone: "warning", title: "Price required", message: "For new items, priceBdt must be > 0." });
        return;
      }
      if (detailsArr.length === 0) {
        toast.push({ tone: "warning", title: "Details required", message: "Add at least one detail line." });
        return;
      }
    }

    setUpsertingItem(true);
    try {
      const res = await adminUpsertItem({
        adminSecret: secret,
        itemId: id,
        quantity: qty,
        name: wantsMeta ? itemName.trim() : undefined,
        priceBdt: wantsMeta ? Math.floor(itemPrice) : undefined,
        details: wantsMeta ? detailsArr : undefined,
      });

      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Item upsert failed", message: `${res.error.message} (${res.error.code})` });
        return;
      }

      toast.push({
        tone: "success",
        title: res.created ? "Item created" : "Item updated",
        message: `${res.itemId} qty=${res.quantity}${typeof res.priceBdt === "number" ? ` • BDT ${res.priceBdt}` : ""}`,
        durationMs: 3500,
      });

      refreshInventory().catch(() => {});
    } catch (err) {
      toast.push({ tone: "danger", title: "Item upsert failed", message: getErrorMessage(err) });
    } finally {
      setUpsertingItem(false);
    }
  }

  async function refreshStudents() {
    const secret = adminSecret.trim();
    if (!secret) return;

    setStudentsLoading(true);
    try {
      const res = await adminListStudents(secret);
      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Students load failed", message: `${res.error.message} (${res.error.code})` });
        setStudents([]);
        return;
      }
      setStudents(res.students || []);
    } catch (err) {
      setStudents([]);
      toast.push({ tone: "danger", title: "Students load failed", message: getErrorMessage(err) });
    } finally {
      setStudentsLoading(false);
    }
  }

  async function doCreateStudent() {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    const sid = studentCreateId.trim();
    const nm = studentCreateName.trim();
    const pw = studentCreatePass;

    if (!sid) {
      toast.push({ tone: "warning", title: "studentId required", message: "Enter a studentId." });
      return;
    }
    if (!nm) {
      toast.push({ tone: "warning", title: "Name required", message: "Enter a student name." });
      return;
    }
    if (!pw || pw.length < 6) {
      toast.push({ tone: "warning", title: "Password required", message: "Password must be at least 6 characters." });
      return;
    }

    setCreatingStudent(true);
    try {
      const res = await adminCreateStudent({
        adminSecret: secret,
        studentId: sid,
        name: nm,
        password: pw,
        balanceBdt: Math.max(0, Math.floor(Number(studentCreateBalance) || 0)),
      });

      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Create student failed", message: `${res.error.message} (${res.error.code})` });
        return;
      }

      toast.push({
        tone: "success",
        title: "Student created",
        message: `${res.studentId} (${res.name}) • Balance BDT ${res.balanceBdt}`,
        durationMs: 3500,
      });

      setStudentCreateId((prev) =>
        prev.startsWith("student") ? `student${Math.max(3, Number(prev.replace("student", "")) + 1 || 4)}` : prev
      );
      await refreshStudents();
    } catch (err) {
      toast.push({ tone: "danger", title: "Create student failed", message: getErrorMessage(err) });
    } finally {
      setCreatingStudent(false);
    }
  }

  async function doDeleteStudent(studentId: string, role: string) {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    if (role !== "student") {
      toast.push({ tone: "warning", title: "Not allowed", message: "Admin accounts cannot be deleted." });
      return;
    }

    const okConfirm = window.confirm(`Delete student "${studentId}"? This cannot be undone.`);
    if (!okConfirm) return;

    setDeletingStudentId(studentId);
    try {
      const res = await adminDeleteStudent({ adminSecret: secret, studentId });
      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Delete failed", message: `${res.error.message} (${res.error.code})` });
        return;
      }
      toast.push({ tone: "success", title: "Deleted", message: `Student ${res.studentId} deleted.` });
      await refreshStudents();
    } catch (err) {
      toast.push({ tone: "danger", title: "Delete failed", message: getErrorMessage(err) });
    } finally {
      setDeletingStudentId(null);
    }
  }

  async function refreshInventory() {
    const secret = adminSecret.trim();
    if (!secret) return;

    setInventoryLoading(true);
    try {
      const res = await adminListItems(secret);
      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Inventory load failed", message: `${res.error.message} (${res.error.code})` });
        setInventory([]);
        return;
      }
      setInventory(res.items || []);
    } catch (err) {
      setInventory([]);
      toast.push({ tone: "danger", title: "Inventory load failed", message: getErrorMessage(err) });
    } finally {
      setInventoryLoading(false);
    }
  }

  async function doDeleteItem(itemIdToDelete: string) {
    const secret = ensureAdminSecretOrToast();
    if (!secret) return;

    const okConfirm = window.confirm(`Delete item "${itemIdToDelete}"? This will remove it from menu/stock.`);
    if (!okConfirm) return;

    setDeletingItemId(itemIdToDelete);
    try {
      const res = await adminDeleteItem({ adminSecret: secret, itemId: itemIdToDelete });
      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Delete item failed", message: `${res.error.message} (${res.error.code})` });
        return;
      }
      toast.push({ tone: "success", title: "Item deleted", message: `${res.itemId} removed.` });
      await refreshInventory();
    } catch (err) {
      toast.push({ tone: "danger", title: "Delete item failed", message: getErrorMessage(err) });
    } finally {
      setDeletingItemId(null);
    }
  }

  async function refreshOrders() {
    const secret = adminSecret.trim();
    if (!secret) return;

    setOrdersLoading(true);
    try {
      const res = await adminListOrders({
        adminSecret: secret,
        studentId: ordersStudentFilter.trim() || undefined,
        status: ordersStatusFilter.trim() || undefined,
        limit: clampLimit(ordersLimit),
      });

      if (isApiError(res)) {
        toast.push({ tone: "danger", title: "Orders load failed", message: `${res.error.message} (${res.error.code})` });
        setOrders([]);
        return;
      }
      setOrders(res.orders || []);
    } catch (err) {
      setOrders([]);
      toast.push({ tone: "danger", title: "Orders load failed", message: getErrorMessage(err) });
    } finally {
      setOrdersLoading(false);
    }
  }

  useEffect(() => {
    refreshHealth().catch(() => {});
    refreshMetrics().catch(() => {});

    const healthTimer = setInterval(() => refreshHealth().catch(() => {}), 5000);
    const metricsTimer = setInterval(() => refreshMetrics().catch(() => {}), 6000);

    return () => {
      clearInterval(healthTimer);
      clearInterval(metricsTimer);
    };
  }, []);

  useEffect(() => {
    if (!adminSecret.trim()) return;
    refreshStudents().catch(() => {});
    refreshInventory().catch(() => {});
    refreshOrders().catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-1 text-xs font-semibold text-slate-200">
            <span className={cn("h-2 w-2 rounded-full", overallOk ? "bg-emerald-400" : "bg-rose-400")} />
            Admin Dashboard
          </div>

          <h1 className="mt-3 text-2xl font-black tracking-tight sm:text-3xl">Inventory, Students, History</h1>

          <p className="mt-1 text-sm text-slate-300">
            Health + metrics + chaos, plus admin controls for students, items, and full transaction history.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={refreshHealth} loading={loadingHealth}>
            Refresh health
          </Button>
          <Button variant="secondary" onClick={refreshMetrics} loading={loadingMetrics}>
            Refresh metrics
          </Button>
        </div>
      </div>


      {/*health grid*/}
      <Card>
        <CardHeader>
          <CardTitle>Service health</CardTitle>
          <CardDescription>Each service returns 200 if healthy, otherwise 503.</CardDescription>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {SERVICES.map((svc) => {
            const h = healthMap[svc.name];
            const okService = h?.ok === true;

            return (
              <div
                key={svc.name}
                className={cn(
                  "rounded-2xl border p-4",
                  okService ? "border-emerald-500/30 bg-emerald-500/10" : "border-rose-500/30 bg-rose-500/10"
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-extrabold text-slate-100">{svc.name.toUpperCase()}</div>
                    <div className="mt-1 break-all text-xs text-slate-300">{svc.baseUrl}</div>
                  </div>
                  <Badge tone={okService ? "success" : "danger"}>{okService ? "HEALTHY" : "DOWN"}</Badge>
                </div>

                <div className="mt-3 text-xs text-slate-300">
                  Last checked:{" "}
                  <span className="font-semibold text-slate-100">{h?.lastCheckedAt ? formatTime(h.lastCheckedAt) : "..."}</span>
                </div>

                <div className="mt-3">
                  <Button
                    size="sm"
                    variant="danger"
                    className="w-full"
                    onClick={() => killService(svc)}
                    loading={killingService === svc.name}
                  >
                    Kill service
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/*metrics*/}
      <Card>
        <CardHeader>
          <CardTitle>Live metrics</CardTitle>
          <CardDescription>Throughput and latency derived from /metrics.</CardDescription>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {SERVICES.map((svc) => {
            const m = metricsMap[svc.name];
            const snap = m?.snapshot;
            const avgLatency = snap?.avgLatencyMs;
            const rps = m?.rps;

            return (
              <div key={svc.name} className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-extrabold text-slate-100">{svc.name.toUpperCase()}</div>
                    <div className="mt-1 text-xs text-slate-400">
                      Updated: {snap?.fetchedAt ? formatTime(snap.fetchedAt) : "..."}
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
                    {typeof snap?.httpRequestsTotal === "number" ? snap.httpRequestsTotal : "..."}
                  </span>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {typeof snap?.ordersCreatedTotal === "number" ? (
                    <Badge tone="neutral">orders_created: {snap.ordersCreatedTotal}</Badge>
                  ) : null}
                  {typeof snap?.ordersFailedTotal === "number" ? (
                    <Badge tone="danger">orders_failed: {snap.ordersFailedTotal}</Badge>
                  ) : null}
                  {typeof snap?.stockDecrementSuccessTotal === "number" ? (
                    <Badge tone="neutral">stock_ok: {snap.stockDecrementSuccessTotal}</Badge>
                  ) : null}
                  {typeof snap?.stockDecrementFailTotal === "number" ? (
                    <Badge tone="danger">stock_fail: {snap.stockDecrementFailTotal}</Badge>
                  ) : null}
                  {typeof snap?.kitchenJobsProcessedTotal === "number" ? (
                    <Badge tone="neutral">kitchen_ok: {snap.kitchenJobsProcessedTotal}</Badge>
                  ) : null}
                  {typeof snap?.kitchenJobsFailedTotal === "number" ? (
                    <Badge tone="danger">kitchen_fail: {snap.kitchenJobsFailedTotal}</Badge>
                  ) : null}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
      

      {/*student management*/}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Students</CardTitle>
              <CardDescription>Create and remove student accounts (admin only).</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={refreshStudents} loading={studentsLoading}>
                Refresh students
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <Input label="studentId" value={studentCreateId} onChange={(e) => setStudentCreateId(e.target.value)} placeholder="student3" />
            <Input label="name" value={studentCreateName} onChange={(e) => setStudentCreateName(e.target.value)} placeholder="New Student" />
            <Input
              label="password"
              value={studentCreatePass}
              onChange={(e) => setStudentCreatePass(e.target.value)}
              placeholder="password123"
            />
            <Input
              label="initial balance (BDT)"
              type="number"
              value={String(studentCreateBalance)}
              onChange={(e) => setStudentCreateBalance(Math.max(0, Math.floor(Number(e.target.value))))}
              placeholder="200"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={doCreateStudent} loading={creatingStudent}>
              Create student
            </Button>
            <div className="text-xs text-slate-500">
              Tip: Use this to create demo accounts quickly (then login as that student).
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/30">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-xs text-slate-300">
                <tr>
                  <th className="px-4 py-3">studentId</th>
                  <th className="px-4 py-3">name</th>
                  <th className="px-4 py-3">role</th>
                  <th className="px-4 py-3">balance</th>
                  <th className="px-4 py-3">updated</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {studentsLoading ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={6}>
                      Loading students...
                    </td>
                  </tr>
                ) : students.length === 0 ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={6}>
                      No students found.
                    </td>
                  </tr>
                ) : (
                  students.map((s, idx) => (
                    <tr key={`${s.studentId}-${idx}`} className="border-b border-slate-900/60">
                      <td className="px-4 py-3 font-semibold text-slate-100">{s.studentId}</td>
                      <td className="px-4 py-3 text-slate-200">{s.name ?? "-"}</td>
                      <td className="px-4 py-3">
                        <Badge tone={s.role === "admin" ? "info" : "neutral"}>{s.role}</Badge>
                      </td>
                      <td className="px-4 py-3 text-slate-200">
                        {s.role === "student" ? `BDT ${Number(s.balanceBdt ?? 0)}` : "-"}
                      </td>
                      <td className="px-4 py-3 text-slate-400">{s.updatedAt ? formatTime(String(s.updatedAt)) : "-"}</td>
                      <td className="px-4 py-3">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => doDeleteStudent(s.studentId, s.role)}
                          loading={deletingStudentId === s.studentId}
                          disabled={s.role !== "student"}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/*wallet recharge*/}
      <Card>
        <CardHeader>
          <CardTitle>Wallet recharge</CardTitle>
          <CardDescription>Recharge a student balance (idempotent).</CardDescription>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          <Input
            label="Student ID"
            value={rechargeStudentId}
            onChange={(e) => setRechargeStudentId(e.target.value)}
            placeholder="student1"
          />

          <Input
            label="Amount (BDT)"
            type="number"
            value={String(rechargeAmount)}
            onChange={(e) => setRechargeAmount(Math.max(0, Math.floor(Number(e.target.value))))}
            placeholder="100"
          />

          <Input
            label="Idempotency-Key"
            value={rechargeIdemKey}
            onChange={(e) => setRechargeIdemKey(e.target.value)}
            placeholder="auto-generated"
            hint="Retrying with same key must not double-recharge."
          />

          <div className="flex items-end gap-2">
            <Button variant="secondary" className="w-full" onClick={() => setRechargeIdemKey(uuidv4())} disabled={recharging}>
              New key
            </Button>
            <Button className="w-full" onClick={doRecharge} loading={recharging}>
              Recharge
            </Button>
          </div>

          <div className="lg:col-span-4 rounded-2xl border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-400">
            Demo tip: Click Recharge twice with the same Idempotency-Key. Second call should be idempotent replay (no double credit).
          </div>
        </CardContent>
      </Card>

      {/*stock*/}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Stock: Add / Update Item</CardTitle>
              <CardDescription>
                Create new items (name + price + details required) or restock existing items.
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={refreshInventory} loading={inventoryLoading}>
                Refresh inventory
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="grid grid-cols-1 gap-3 lg:grid-cols-4">
          <Input label="Item ID" value={itemId} onChange={(e) => setItemId(e.target.value)} placeholder="ITEM04" />

          <Input
            label="Quantity (+ add)"
            type="number"
            value={String(itemQty)}
            onChange={(e) => setItemQty(clampQty(Number(e.target.value)))}
            placeholder="10"
            hint="Existing: adds quantity. New: initial quantity."
          />

          <Input label="Name (required for new item)" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="Iftar Box C" />

          <Input
            label="Price BDT (required for new item)"
            type="number"
            value={String(itemPrice)}
            onChange={(e) => setItemPrice(Math.max(0, Math.floor(Number(e.target.value))))}
            placeholder="180"
          />

          <div className="lg:col-span-3">
            <label className="mb-1 block text-sm font-semibold text-slate-200">Details (one per line)</label>
            <textarea
              className="min-h-[120px] w-full rounded-2xl border border-slate-800 bg-slate-950/30 px-3 py-3 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-cyan-400/30"
              value={itemDetailsText}
              onChange={(e) => setItemDetailsText(e.target.value)}
              placeholder={"- 3 dates\n- 1 juice\n- 1 biriyani"}
            />
            <div className="mt-1 text-xs text-slate-400">
              If you provide any of (name/price/details), all 3 are required (new item rule). Otherwise it behaves like restock.
            </div>
          </div>

          <div className="flex items-end gap-2">
            <Button
              variant="secondary"
              className="w-full"
              onClick={() => {
                setItemName("Iftar Box C");
                setItemPrice(180);
                setItemDetailsText("- 3 dates\n- 1 juice\n- 1 biriyani\n- salad");
              }}
              disabled={upsertingItem}
            >
              Fill example
            </Button>
            <Button className="w-full" onClick={doUpsertItem} loading={upsertingItem}>
              Save / Restock
            </Button>
          </div>

          <div className="lg:col-span-4 rounded-2xl border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-400">
            New item demo: set a new ITEM id (e.g. ITEM04), fill name/price/details, set quantity, Save. Student menu shows it after refresh.
          </div>
        </CardContent>
      </Card>

      {/*inventory table*/}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Inventory (Stock)</CardTitle>
              <CardDescription>All items with quantity, price, and details.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={refreshInventory} loading={inventoryLoading}>
                Refresh
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/30">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-xs text-slate-300">
                <tr>
                  <th className="px-4 py-3">itemId</th>
                  <th className="px-4 py-3">name</th>
                  <th className="px-4 py-3">qty</th>
                  <th className="px-4 py-3">price</th>
                  <th className="px-4 py-3">details</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody>
                {inventoryLoading ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={6}>
                      Loading inventory...
                    </td>
                  </tr>
                ) : inventory.length === 0 ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={6}>
                      No items found.
                    </td>
                  </tr>
                ) : (
                  inventory.map((it, idx) => (
                    <tr key={`${it.itemId}-${idx}`} className="border-b border-slate-900/60">
                      <td className="px-4 py-3 font-semibold text-slate-100">{it.itemId}</td>
                      <td className="px-4 py-3 text-slate-200">{it.name}</td>
                      <td className="px-4 py-3">
                        <Badge tone={it.quantity <= 0 ? "danger" : it.quantity <= 3 ? "warning" : "success"}>
                          {it.quantity}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-slate-200">BDT {it.priceBdt}</td>
                      <td className="px-4 py-3 text-slate-300">
                        {Array.isArray(it.details) && it.details.length > 0 ? it.details.slice(0, 4).join(", ") : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => doDeleteItem(it.itemId)}
                          loading={deletingItemId === it.itemId}
                        >
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/*order history*/}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <CardTitle>Orders history</CardTitle>
              <CardDescription>All purchases with idempotency keys, price/amount, and timestamps.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={refreshOrders} loading={ordersLoading}>
                Refresh orders
              </Button>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
            <Input
              label="Filter studentId (optional)"
              value={ordersStudentFilter}
              onChange={(e) => setOrdersStudentFilter(e.target.value)}
              placeholder="student1"
            />
            <Input
              label="Filter status (optional)"
              value={ordersStatusFilter}
              onChange={(e) => setOrdersStatusFilter(e.target.value)}
              placeholder="READY"
            />
            <Input
              label="Limit (1-200)"
              type="number"
              value={String(ordersLimit)}
              onChange={(e) => setOrdersLimit(clampLimit(Number(e.target.value)))}
              placeholder="50"
            />
            <div className="flex items-end">
              <Button className="w-full" onClick={refreshOrders} loading={ordersLoading}>
                Apply filters
              </Button>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-slate-950/30">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-xs text-slate-300">
                <tr>
                  <th className="px-4 py-3">orderId</th>
                  <th className="px-4 py-3">student</th>
                  <th className="px-4 py-3">item</th>
                  <th className="px-4 py-3">qty</th>
                  <th className="px-4 py-3">amount</th>
                  <th className="px-4 py-3">status</th>
                  <th className="px-4 py-3">idempotency</th>
                  <th className="px-4 py-3">time</th>
                </tr>
              </thead>
              <tbody>
                {ordersLoading ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={8}>
                      Loading orders...
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td className="px-4 py-4 text-slate-400" colSpan={8}>
                      No orders found.
                    </td>
                  </tr>
                ) : (
                  orders.map((o, idx) => (
                    <tr key={`${o.orderId}-${idx}`} className="border-b border-slate-900/60">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => handleCopy("Order ID", o.orderId)}
                          className="max-w-[240px] truncate font-semibold text-slate-100 underline decoration-slate-600/60 underline-offset-2 hover:decoration-slate-200"
                          title="Click to copy full Order ID"
                          aria-label="Copy orderId"
                        >
                          {truncateTo(o.orderId, 16)}
                        </button>
                      </td>
                      <td className="px-4 py-3 text-slate-200">{o.studentId}</td>
                      <td className="px-4 py-3 text-slate-200">{o.itemId}</td>
                      <td className="px-4 py-3 text-slate-200">{o.quantity}</td>
                      <td className="px-4 py-3 text-slate-200">
                        {typeof o.amountBdt === "number" ? `BDT ${o.amountBdt}` : "-"}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={o.status === "FAILED" ? "danger" : o.status === "READY" ? "success" : "info"}>
                          {o.status}
                        </Badge>
                      </td>
                      <td className="px-4 py-3">
                        {o.idempotencyKey ? (
                          <button
                            type="button"
                            onClick={() => handleCopy("Idempotency key", o.idempotencyKey ?? "")}
                            className="max-w-[240px] truncate text-xs text-slate-300 underline decoration-slate-600/60 underline-offset-2 hover:decoration-slate-200"
                            title="Click to copy full Idempotency-Key"
                            aria-label="Copy idempotency key"
                          >
                            {truncateTo(o.idempotencyKey ?? "", 16)}
                          </button>
                        ) : (
                          <span className="text-xs text-slate-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {o.createdAt ? formatTime(String(o.createdAt)) : "-"}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

     {/*admin control*/}
      <Card>
        <CardHeader>
          <CardTitle>Admin controls</CardTitle>
          <CardDescription>Admin secret authorizes chaos, wallet, student, and stock operations (demo only).</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="x-admin-secret"
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
            placeholder="dev_admin_secret_change_me"
            hint="Used for /admin/* and protected admin operations."
          />

          <div className="rounded-2xl border border-slate-800 bg-slate-950/30 p-4">
            <div className="text-xs font-bold text-slate-200">Bonus alert</div>
            <div className="mt-2 text-sm text-slate-300">
              Gateway avg latency (last ~30s):
              <span className="ml-2 font-extrabold text-slate-100">
                {gatewayLatencyAlert ? `${Math.round(gatewayLatencyAlert.avg30sMs)}ms` : "..."}
              </span>
            </div>
            <div className="mt-2">
              {gatewayLatencyAlert?.triggered ? <Badge tone="warning">ALERT</Badge> : <Badge tone="success">Normal</Badge>}
            </div>
          </div>
        </CardContent>
      </Card>


    </div>
  );
}