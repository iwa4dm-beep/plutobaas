import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, RefreshCw, Activity, Database, ShieldCheck, GitCommit, Lock } from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";

export const Route = createFileRoute("/dashboard/backend-status")({
  head: () => ({
    meta: [
      { title: "Backend Status — Pluto Dashboard" },
      { name: "description", content: "Live health, readiness, and migration status for the Pluto backend." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: BackendStatusPage,
});

const API = (import.meta.env.VITE_PLUTO_API_URL as string) || "https://api.timescard.cloud";
const REFRESH_MS = 15_000;

type LiveResp = { status: string; uptime?: number; ts?: string };
type ReadyResp = { status: string; checks?: Record<string, { ok: boolean; latencyMs?: number; error?: string }>; ts?: string };
type MigResp = {
  status: string;
  migrations?: { ok: boolean; count: number; current: string; applied: string[] };
  audit_log_columns?: { ok: boolean; present: number; missing: string[]; typeMismatch: string[] };
  audit_log_fk?: { ok: boolean; name: string; definition: string };
  audit_log_indexes?: { ok: boolean; present: string[]; missing: string[] };
  ts?: string;
};

type Fetched<T> = { data: T | null; error: string | null; loading: boolean; ms: number };

async function probe<T>(path: string): Promise<Fetched<T>> {
  const t0 = performance.now();
  try {
    const r = await fetch(`${API}${path}`, { cache: "no-store" });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return { data: null, error: `HTTP ${r.status}`, loading: false, ms };
    const data = (await r.json()) as T;
    return { data, error: null, loading: false, ms };
  } catch (e) {
    return { data: null, error: (e as Error).message, loading: false, ms: Math.round(performance.now() - t0) };
  }
}

function Badge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${ok ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-rose-500/10 text-rose-600 dark:text-rose-400"}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function Card({ title, icon, children, ms, ok }: { title: string; icon: React.ReactNode; children: React.ReactNode; ms?: number; ok?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          {title}
        </div>
        <div className="flex items-center gap-2">
          {typeof ms === "number" && <span className="text-xs text-muted-foreground">{ms} ms</span>}
          {typeof ok === "boolean" && <Badge ok={ok} label={ok ? "healthy" : "down"} />}
        </div>
      </div>
      {children}
    </div>
  );
}

function BackendStatusPage() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [live, setLive] = useState<Fetched<LiveResp>>({ data: null, error: null, loading: true, ms: 0 });
  const [ready, setReady] = useState<Fetched<ReadyResp>>({ data: null, error: null, loading: true, ms: 0 });
  const [mig, setMig] = useState<Fetched<MigResp>>({ data: null, error: null, loading: true, ms: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const authed = !!session;
  const isAdmin = authed && (session as any)?.role === "admin";

  const refresh = async () => {
    if (!authed) return;
    setRefreshing(true);
    const headers: HeadersInit = (session as any)?.token
      ? { Authorization: `Bearer ${(session as any).token}` }
      : {};
    const probeAuth = async <T,>(path: string): Promise<Fetched<T>> => {
      const t0 = performance.now();
      try {
        const r = await fetch(`${API}${path}`, { cache: "no-store", headers });
        const ms = Math.round(performance.now() - t0);
        if (!r.ok) return { data: null, error: `HTTP ${r.status}`, loading: false, ms };
        return { data: (await r.json()) as T, error: null, loading: false, ms };
      } catch (e) {
        return { data: null, error: (e as Error).message, loading: false, ms: Math.round(performance.now() - t0) };
      }
    };
    const [l, r, m] = await Promise.all([
      probeAuth<LiveResp>("/livez"),
      probeAuth<ReadyResp>("/readyz"),
      probeAuth<MigResp>("/health/migrations"),
    ]);
    setLive(l); setReady(r); setMig(m);
    setLastUpdated(new Date());
    setRefreshing(false);
  };

  useEffect(() => {
    if (!authed) return;
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authed]);

  if (authLoading) {
    return <main className="mx-auto max-w-5xl p-6"><p className="text-sm text-muted-foreground">Loading…</p></main>;
  }

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center p-6 text-center">
        <Lock className="mb-3 h-8 w-8 text-muted-foreground" />
        <h1 className="text-xl font-semibold text-foreground">Sign in required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Backend status is restricted to authorized users only.
        </p>
        <button
          onClick={() => navigate({ to: "/auth", search: { redirect: "/dashboard/backend-status" } as any })}
          className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Sign in
        </button>
        <Link to="/" className="mt-2 text-xs text-muted-foreground hover:underline">Back to home</Link>
      </main>
    );
  }

  if (!isAdmin) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center p-6 text-center">
        <Lock className="mb-3 h-8 w-8 text-rose-500" />
        <h1 className="text-xl font-semibold text-foreground">Forbidden</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          This page is restricted to admin accounts. Signed in as{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{session?.email}</code>.
        </p>
      </main>
    );
  }


  const allOk = live.data?.status === "ok" && (ready.data?.status === "ok" || ready.data?.status === "ready") && mig.data?.status === "ok";

  return (
    <main className="mx-auto max-w-5xl p-6 md:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Backend Status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Probing <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{API}</code> every {REFRESH_MS / 1000}s
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className={`mb-6 rounded-xl border p-4 ${allOk ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5"}`}>
        <div className="flex items-center gap-2">
          {allOk ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-rose-500" />}
          <span className="font-semibold text-foreground">
            {allOk ? "All systems operational" : "One or more checks failing"}
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Liveness /livez" icon={<Activity className="h-4 w-4 text-emerald-500" />} ms={live.ms} ok={live.data?.status === "ok"}>
          {live.error ? (
            <p className="text-sm text-rose-500">{live.error}</p>
          ) : live.data ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">status</dt><dd className="font-mono">{live.data.status}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">uptime</dt><dd className="font-mono">{live.data.uptime}s</dd></div>
            </dl>
          ) : <p className="text-sm text-muted-foreground">loading…</p>}
        </Card>

        <Card title="Readiness /readyz" icon={<Database className="h-4 w-4 text-blue-500" />} ms={ready.ms} ok={ready.data?.status === "ok" || ready.data?.status === "ready"}>
          {ready.error ? (
            <p className="text-sm text-rose-500">{ready.error}</p>
          ) : ready.data?.checks ? (
            <ul className="space-y-1 text-sm">
              {Object.entries(ready.data.checks).map(([name, c]) => (
                <li key={name} className="flex items-center justify-between">
                  <span className="text-muted-foreground">{name}</span>
                  <Badge ok={c.ok} label={c.ok ? `${c.latencyMs ?? "?"}ms` : (c.error ?? "fail")} />
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">loading…</p>}
        </Card>

        <Card title="Migrations /health/migrations" icon={<GitCommit className="h-4 w-4 text-violet-500" />} ms={mig.ms} ok={mig.data?.status === "ok"}>
          {mig.error ? (
            <p className="text-sm text-rose-500">{mig.error}</p>
          ) : mig.data?.migrations ? (
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">applied</dt><dd className="font-mono">{mig.data.migrations.count}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">current</dt><dd className="truncate font-mono text-xs">{mig.data.migrations.current}</dd></div>
            </dl>
          ) : <p className="text-sm text-muted-foreground">loading…</p>}
        </Card>
      </div>

      {mig.data && (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <Card title="audit_log columns" icon={<ShieldCheck className="h-4 w-4 text-amber-500" />} ok={mig.data.audit_log_columns?.ok}>
            <p className="text-sm text-muted-foreground">
              {mig.data.audit_log_columns?.present} present
              {mig.data.audit_log_columns?.missing?.length ? `, ${mig.data.audit_log_columns.missing.length} missing` : ""}
            </p>
          </Card>
          <Card title="audit_log FK" icon={<ShieldCheck className="h-4 w-4 text-amber-500" />} ok={mig.data.audit_log_fk?.ok}>
            <p className="truncate text-xs font-mono text-muted-foreground">{mig.data.audit_log_fk?.name ?? "—"}</p>
          </Card>
          <Card title="audit_log indexes" icon={<ShieldCheck className="h-4 w-4 text-amber-500" />} ok={mig.data.audit_log_indexes?.ok}>
            <p className="text-sm text-muted-foreground">{mig.data.audit_log_indexes?.present?.length ?? 0} indexes</p>
          </Card>
        </div>
      )}
    </main>
  );
}
