import { NavBar } from "./NavBar";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="pointer-events-none fixed inset-0 opacity-40">
        <div className="absolute -top-40 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-cyan-500/30 blur-3xl" />
        <div className="absolute -bottom-40 left-20 h-80 w-80 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute -bottom-40 right-20 h-80 w-80 rounded-full bg-rose-500/15 blur-3xl" />
      </div>

      <NavBar />

      <main className="mx-auto max-w-6xl px-4 py-6">
        {children}
        <footer className="mt-10 border-t border-slate-800/60 pt-6 text-center text-xs text-slate-500">
          Demo-ready • Health, Metrics, Chaos • Real-time updates (no polling)
        </footer>
      </main>
    </div>
  );
}