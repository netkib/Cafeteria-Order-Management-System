import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { clearToken, getCurrentUser, getToken } from "../../lib/auth";
import { config } from "../../lib/config";
import { getHealth, getMe } from "../../lib/api";
import { useToast } from "../ui/Toast";

type NavItem = { label: string; to: string; matchPrefix?: boolean };

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      to={item.to}
      className={cn(
        "rounded-xl px-3 py-2 text-sm font-semibold transition",
        active
          ? "bg-cyan-500/15 text-cyan-200 ring-1 ring-cyan-500/30"
          : "text-slate-200 hover:bg-slate-800/60 hover:text-slate-50"
      )}
    >
      {item.label}
    </Link>
  );
}
export function NavBar() {
  const loc = useLocation();
  const nav = useNavigate();
  const toast = useToast();

  const user = useMemo(() => getCurrentUser(), [loc.key]);
  const token = useMemo(() => getToken(), [loc.key]);

  const isAdmin = user?.role === "admin";
  const isStudent = user?.role === "student";

  const navItems: NavItem[] = useMemo(() => {
    const items: NavItem[] = [{ label: "Student", to: "/student/order", matchPrefix: true }];
    if (isAdmin) items.push({ label: "Admin", to: "/admin", matchPrefix: true });
    return items;
  }, [isAdmin]);

  const [systemOk, setSystemOk] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);

  const [balanceBdt, setBalanceBdt] = useState<number | null>(null);
  const [loadingBalance, setLoadingBalance] = useState(false);

  const activeItem = (item: NavItem) => {
    if (item.matchPrefix) return loc.pathname.startsWith(item.to);
    return loc.pathname === item.to;
  };

  async function checkSystem() {
    setChecking(true);
    try {
      const [g, n] = await Promise.all([
        getHealth(config.services.gateway),
        getHealth(config.services.notification),
      ]);
      const ok = (g as any)?.ok === true && (n as any)?.ok === true;
      setSystemOk(ok);
      toast.push({
        tone: ok ? "success" : "warning",
        title: "System check",
        message: ok ? "Gateway & Notification are healthy" : "One or more services look unhealthy",
        durationMs: 2500,
      });
    } catch {
      setSystemOk(false);
      toast.push({
        tone: "danger",
        title: "System check failed",
        message: "Could not reach services",
        durationMs: 3000,
      });
    } finally {
      setChecking(false);
    }
  }

  async function refreshBalance() {
    if (!token || !isStudent) {
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

  useEffect(() => {
    checkSystem().catch(() => {});
  }, []);

  useEffect(() => {
    refreshBalance().catch(() => {});
  }, [loc.key, token, isStudent]);

  function logout() {
    clearToken();
    setBalanceBdt(null);
    toast.push({ tone: "info", title: "Logged out", message: "Session cleared" });
    nav("/student/login", { replace: true });
  }

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800/70 bg-slate-950/40 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-500/15 ring-1 ring-cyan-500/30">
            <span className="text-lg font-black text-cyan-200">C</span>
          </div>
          <div className="leading-tight">
            <div className="text-sm font-extrabold tracking-tight">Cafeteria System</div>
            <div className="text-xs text-slate-400">Real-time ordering • Observability</div>
          </div>
        </div>

        <nav className="hidden items-center gap-1 md:flex">
          {navItems.map((item) => (
            <NavLink key={item.to} item={item} active={activeItem(item)} />
          ))}
        </nav>

        <div className="flex items-center gap-2">
          <button
            onClick={checkSystem}
            disabled={checking}
            className={cn(
              "hidden sm:inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold transition",
              "border-slate-800 bg-slate-950/30 hover:bg-slate-800/50",
              checking ? "opacity-70 cursor-not-allowed" : ""
            )}
            title="Quick health check"
          >
            <span
              className={cn(
                "h-2.5 w-2.5 rounded-full",
                systemOk === null ? "bg-slate-500" : systemOk ? "bg-emerald-400" : "bg-rose-400"
              )}
            />
            <span>{checking ? "Checking..." : "System"}</span>
          </button>

          {user ? (
            <div className="flex items-center gap-2">
              <Badge tone={user.role === "admin" ? "info" : "neutral"}>
                {user.role.toUpperCase()} • {user.studentId}
              </Badge>

              {isStudent ? (
                <button
                  onClick={() => refreshBalance().catch(() => {})}
                  className={cn(
                    "hidden sm:inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold",
                    "border-slate-800 bg-slate-950/30 hover:bg-slate-800/50"
                  )}
                  title="Click to refresh balance"
                >
                  <span className="text-slate-300">{loadingBalance ? "BDT..." : "BDT"}</span>
                  <span className="text-slate-100 font-extrabold">
                    {loadingBalance ? "…" : balanceBdt ?? "—"}
                  </span>
                </button>
              ) : null}
            </div>
          ) : (
            <Badge tone="neutral">GUEST</Badge>
          )}

          <Button variant="ghost" size="sm" onClick={logout}>
            Logout
          </Button>
        </div>
      </div>

      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 pb-3 md:hidden">
        {navItems.map((item) => (
          <NavLink key={item.to} item={item} active={activeItem(item)} />
        ))}

        {user?.role === "student" ? (
          <button
            onClick={() => refreshBalance().catch(() => {})}
            className={cn(
              "ml-auto inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold",
              "border-slate-800 bg-slate-950/30 hover:bg-slate-800/50"
            )}
            title="Click to refresh balance"
          >
            <span className="text-slate-300">{loadingBalance ? "BDT..." : "BDT"}</span>
            <span className="text-slate-100 font-extrabold">
              {loadingBalance ? "…" : balanceBdt ?? "—"}
            </span>
          </button>
        ) : null}
      </div>
    </header>
  );
}