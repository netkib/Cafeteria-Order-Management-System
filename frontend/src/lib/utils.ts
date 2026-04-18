import type { ApiError, OrderStatus } from "../types";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function statusLabel(status: OrderStatus | string) {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "STOCK_VERIFIED":
      return "Stock Verified";
    case "IN_KITCHEN":
      return "In Kitchen";
    case "READY":
      return "Ready";
    case "FAILED":
      return "Failed";
    default:
      return String(status ?? "Unknown");
  }
}

export function statusBadgeClass(status: OrderStatus | string) {
  switch (status) {
    case "PENDING":
      return "bg-slate-800/70 text-slate-100 border border-slate-700";
    case "STOCK_VERIFIED":
      return "bg-cyan-500/15 text-cyan-200 border border-cyan-500/30";
    case "IN_KITCHEN":
      return "bg-amber-500/15 text-amber-200 border border-amber-500/30";
    case "READY":
      return "bg-emerald-500/15 text-emerald-200 border border-emerald-500/30";
    case "FAILED":
      return "bg-rose-500/15 text-rose-200 border border-rose-500/30";
    default:
      return "bg-slate-800/70 text-slate-100 border border-slate-700";
  }
}
export function statusDotClass(status: OrderStatus | string) {
  switch (status) {
    case "PENDING":
      return "bg-slate-400";
    case "STOCK_VERIFIED":
      return "bg-cyan-400";
    case "IN_KITCHEN":
      return "bg-amber-400";
    case "READY":
      return "bg-emerald-400";
    case "FAILED":
      return "bg-rose-400";
    default:
      return "bg-slate-400";
  }
}
export function formatTime(input?: string | Date | null) {
  if (!input) return "";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function getErrorMessage(err: unknown, fallback = "Something went wrong") {
  const e = err as any;

  if (e?.ok === false && e?.error?.message) return String(e.error.message);

  if (e?.message) return String(e.message);

  return fallback;
}

export function isApiError(x: any): x is ApiError {
  return x && x.ok === false && x.error && typeof x.error.message === "string";
}

export function shortId(id: string, keep = 8) {
  const s = String(id ?? "");
  if (s.length <= keep) return s;
  return `${s.slice(0, keep)}…`;
}