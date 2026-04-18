import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/Card";
import { Input } from "../../components/ui/Input";
import { Button } from "../../components/ui/Button";
import { Badge } from "../../components/ui/Badge";
import { useToast } from "../../components/ui/Toast";
import { login } from "../../lib/api";
import { decodeUserFromToken, requireValidSession, setToken } from "../../lib/auth";
import { cn, getErrorMessage } from "../../lib/utils";
import type { ApiError, LoginSuccess } from "../../types";

function isApiError(x: any): x is ApiError {
  return x && x.ok === false && x.error && typeof x.error.message === "string";
}

function isLoginSuccess(x: any): x is LoginSuccess {
  return x && x.ok === true && typeof x.accessToken === "string";
}

export default function LoginPage() {
  const nav = useNavigate();
  const toast = useToast();
  const [studentId, setStudentId] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alreadyLoggedIn = useMemo(() => {
    const user = requireValidSession();
    return user ? user : null;
  }, []);

  useEffect(() => {
    if (!alreadyLoggedIn) return;
    if (alreadyLoggedIn.role === "admin") nav("/admin", { replace: true });
    else nav("/student/order", { replace: true });
  }, [alreadyLoggedIn, nav]);

  function fillDemoStudent() {
    setStudentId("student1");
    setPassword("password123");
    toast.push({
      tone: "info",
      title: "Demo credentials",
      message: "Filled student login: student1 / password123",
      durationMs: 2200,
    });
  }

  function fillDemoAdmin() {
    setStudentId("admin1");
    setPassword("admin123");
    toast.push({
      tone: "info",
      title: "Demo credentials",
      message: "Filled admin login: admin1 / admin123",
      durationMs: 2200,
    });
  }

  async function onSubmit(e: React.SyntheticEvent) {
    e.preventDefault();
    setError(null);

    const sid = studentId.trim();
    if (!sid || sid.length < 3) {
      setError("Student ID must be at least 3 characters.");
      return;
    }
    if (!password || password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await login(sid, password);

      if (isApiError(res)) {
        const msg = res.error.message ?? "Login failed";
        setError(msg);
        toast.push({ tone: "danger", title: "Login failed", message: msg });
        return;
      }

      if (!isLoginSuccess(res)) {
        setError("Login failed");
        toast.push({ tone: "danger", title: "Login failed", message: "Unexpected response" });
        return;
      }

      setToken(res.accessToken);

      const user = decodeUserFromToken(res.accessToken);
      toast.push({
        tone: "success",
        title: "Welcome",
        message: user?.role === "admin" ? "Admin session started" : "Student session started",
        durationMs: 2200,
      });

      if (user?.role === "admin") nav("/admin", { replace: true });
      else nav("/student/order", { replace: true });
    } catch (err) {
      const msg = getErrorMessage(err, "Could not login. Please try again.");
      setError(msg);
      toast.push({ tone: "danger", title: "Network error", message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  if (alreadyLoggedIn) {
    return (
      <div className="mx-auto mt-10 max-w-xl">
        <Card>
          <CardContent className="py-10 text-center">
            <div className="text-sm text-slate-300">Session detected... redirecting</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-1 items-center gap-6 lg:grid-cols-2">
      <div className="order-2 lg:order-1">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-800 bg-slate-950/40 px-3 py-1 text-xs font-semibold text-slate-200">
          <span className="h-2 w-2 rounded-full bg-cyan-400" />
          Real-time Cafeteria Ordering
        </div>

        <h1 className="mt-4 text-3xl font-black tracking-tight sm:text-4xl">
          Order fast. <span className="text-cyan-300">Track live.</span> Pick up ready.
        </h1>

        <p className="mt-3 max-w-xl text-sm leading-6 text-slate-300">
          This system showcases secure JWT login, cache-first stock checks, idempotent ordering,
          asynchronous kitchen processing, and real-time notifications - all running in Docker
          microservices.
        </p>

        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Feature title="JWT Auth" desc="Secure token handshake" tone="info" />
          <Feature title="Async Kitchen" desc="3-7s cook time" tone="warning" />
          <Feature title="Live Updates" desc="No polling" tone="success" />
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={fillDemoStudent}>
            Use Student Demo
          </Button>
          <Button type="button" variant="ghost" onClick={fillDemoAdmin}>
            Use Admin Demo
          </Button>
        </div>

        <div className="mt-4 text-xs text-slate-500">
          Tip: Use Student demo to see live order status. Use Admin demo to monitor health/metrics and trigger chaos.
        </div>
      </div>

      {/* right side*/}
      <div className="order-1 lg:order-2">
        <Card className="mx-auto w-full max-w-md">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>Enter your student ID and password to get a secure access token.</CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              <Input
                label="Student ID"
                name="studentId"
                placeholder="e.g., student1"
                value={studentId}
                onChange={(e) => setStudentId(e.target.value)}
                autoComplete="username"
              />

              <Input
                label="Password"
                name="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />

              {error ? (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                  {error}
                </div>
              ) : null}

              <Button type="submit" className="w-full" loading={submitting}>
                {submitting ? "Signing in..." : "Sign in"}
              </Button>

              <div className="flex items-center justify-between pt-1 text-xs text-slate-400">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Identity Provider is used for auth
                </span>
                <span className="opacity-80">Token stored locally</span>
              </div>

              <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
                <div className="text-xs font-bold text-slate-200">Demo accounts</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge tone="neutral">student1 / password123</Badge>
                  <Badge tone="info">admin1 / admin123</Badge>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="mx-auto mt-3 max-w-md text-center text-xs text-slate-500">
          If login fails repeatedly, the Identity Provider may rate-limit attempts (bonus feature).
        </div>
      </div>
    </div>
  );
}

function Feature({
  title,
  desc,
  tone,
}: {
  title: string;
  desc: string;
  tone: "neutral" | "success" | "warning" | "danger" | "info";
}) {
  return (
    <div className={cn("rounded-2xl border border-slate-800 bg-slate-950/30 p-4")}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-extrabold">{title}</div>
        <Badge tone={tone}>{tone.toUpperCase()}</Badge>
      </div>
      <div className="mt-2 text-sm text-slate-300">{desc}</div>
    </div>
  );
}