import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { cn } from "../../lib/utils";

type ToastTone = "success" | "info" | "warning" | "danger";

export type ToastItem = {
  id: string;
  title?: string;
  message: string;
  tone: ToastTone;
  createdAt: number;
  durationMs: number;
};

type ToastContextValue = {
  push: (t: { title?: string; message: string; tone?: ToastTone; durationMs?: number }) => void;
  clear: () => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

function toneClasses(tone: ToastTone) {
  switch (tone) {
    case "success":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-100";
    case "info":
      return "border-cyan-500/30 bg-cyan-500/10 text-cyan-100";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-100";
    case "danger":
      return "border-rose-500/30 bg-rose-500/10 text-rose-100";
  }
}

function icon(tone: ToastTone) {
  // simple unicode icons so no deps
  switch (tone) {
    case "success":
      return "✅";
    case "info":
      return "ℹ️";
    case "warning":
      return "⚠️";
    case "danger":
      return "⛔";
  }
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const remove = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (t: { title?: string; message: string; tone?: ToastTone; durationMs?: number }) => {
      const item: ToastItem = {
        id: uid(),
        title: t.title,
        message: t.message,
        tone: t.tone ?? "info",
        createdAt: Date.now(),
        durationMs: t.durationMs ?? 3500,
      };

      setToasts((prev) => [item, ...prev].slice(0, 5)); // cap to 5

      window.setTimeout(() => remove(item.id), item.durationMs);
    },
    [remove]
  );

  const clear = useCallback(() => setToasts([]), []);

  const value = useMemo(() => ({ push, clear }), [push, clear]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={remove} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return ctx;
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className={cn(
        "fixed z-50 flex w-full flex-col gap-2 p-4",
        "bottom-0 left-0 sm:bottom-4 sm:left-auto sm:right-4 sm:w-[420px]"
      )}
      aria-live="polite"
      aria-relevant="additions"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rounded-2xl border backdrop-blur",
            "shadow-lg shadow-black/30",
            "px-4 py-3",
            toneClasses(t.tone)
          )}
          role="status"
        >
          <div className="flex items-start gap-3">
            <div className="mt-0.5 text-lg" aria-hidden="true">
              {icon(t.tone)}
            </div>
            <div className="min-w-0 flex-1">
              {t.title ? (
                <div className="text-sm font-extrabold leading-tight">{t.title}</div>
              ) : null}
              <div className="mt-0.5 text-sm text-slate-100/90">{t.message}</div>
            </div>
            <button
              onClick={() => onDismiss(t.id)}
              className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-200/80 hover:bg-white/10 hover:text-slate-100"
              aria-label="Dismiss notification"
            >
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}