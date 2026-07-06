import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import {
  Activity, CheckCircle2, XCircle, RefreshCw, Database, ShieldCheck, GitCommit,
  Lock, Plug, Clock, TrendingUp,
} from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";
import { AdminGate } from "@/components/AdminGate";

export const Route = createFileRoute("/dashboard/backend-status")({
  head: () => ({
    meta: [
      { title: "Backend Status — Pluto Dashboard" },
      { name: "description", content: "Live health, readiness, migrations, latency history and connection tests for the Pluto backend." },
      { name: "robots", content: "noindex,nofollow" },
    ],
  }),
  component: ProtectedBackendStatus,
});

function ProtectedBackendStatus() {
  return (
    <AdminGate>
      <BackendStatusPage />
    </AdminGate>
  );
}

const API = (import.meta.env.VITE_PLUTO_BROWSER_URL as string) || "/api/pluto";
const REFRESH_MS = 15_000;
const HISTORY_LIMIT = 40;

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

type Probe = { at: number; ok: boolean; ms: number; code: number | null; note?: string };
type Fetched<T> = { data: T | null; error: string | null; loading: boolean; ms: number; at: number; code: number | null };

async function probe<T>(path: string, headers: HeadersInit = {}): Promise<Fetched<T>> {
  const t0 = performance.now();
  const at = Date.now();
  try {
    const r = await fetch(`${API}${path}`, { cache: "no-store", headers });
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) return { data: null, error: `HTTP ${r.status}`, loading: false, ms, at, code: r.status };
    const data = (await r.json()) as T;
    return { data, error: null, loading: false, ms, at, code: r.status };
  } catch (e) {
    return { data: null, error: (e as Error).message, loading: false, ms: Math.round(performance.now() - t0), at, code: null };
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

function relTime(ts: number | null): string {
  if (!ts) return "—";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Sparkline({ probes }: { probes: Probe[] }) {
  if (probes.length === 0) return <div className="h-8 text-xs text-muted-foreground">no data yet</div>;
  const max = Math.max(...probes.map(p => p.ms), 100);
  return (
    <div className="flex h-8 items-end gap-[2px]">
      {probes.slice(-HISTORY_LIMIT).map((p, i) => (
        <div
          key={i}
          title={`${new Date(p.at).toLocaleTimeString()} · ${p.ok ? "OK" : "FAIL"} · ${p.ms}ms${p.code ? ` · HTTP ${p.code}` : ""}`}
          className={`w-1.5 rounded-sm ${p.ok ? "bg-emerald-500/70" : "bg-rose-500/80"}`}
          style={{ height: `${Math.max(8, (p.ms / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function EndpointCard({
  title, icon, path, fetched, history,
}: {
  title: string; icon: React.ReactNode; path: string;
  fetched: Fetched<unknown>; history: Probe[];
}) {
  const ok = fetched.data !== null && !fetched.error;
  const stats = (() => {
    if (history.length === 0) return { uptime: 0, avg: 0, p95: 0 };
    const okCount = history.filter(p => p.ok).length;
    const times = history.filter(p => p.ok).map(p => p.ms).sort((a, b) => a - b);
    const avg = times.length ? Math.round(times.reduce((s, x) => s + x, 0) / times.length) : 0;
    const p95 = times.length ? times[Math.min(times.length - 1, Math.floor(times.length * 0.95))] : 0;
    return { uptime: Math.round((okCount / history.length) * 100), avg, p95 };
  })();

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <Badge ok={ok} label={ok ? "healthy" : "down"} />
      </div>
      <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground">
        <code className="truncate font-mono">{path}</code>
        <span>{fetched.ms} ms · {fetched.code ?? "—"}</span>
      </div>
      <Sparkline probes={history} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <div className="rounded-md bg-muted/40 p-2 text-center">
          <div className="font-mono text-sm font-semibold text-foreground">{stats.uptime}%</div>
          <div className="text-[10px] uppercase text-muted-foreground">uptime</div>
        </div>
        <div className="rounded-md bg-muted/40 p-2 text-center">
          <div className="font-mono text-sm font-semibold text-foreground">{stats.avg}ms</div>
          <div className="text-[10px] uppercase text-muted-foreground">avg</div>
        </div>
        <div className="rounded-md bg-muted/40 p-2 text-center">
          <div className="font-mono text-sm font-semibold text-foreground">{stats.p95}ms</div>
          <div className="text-[10px] uppercase text-muted-foreground">p95</div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 text-[11px] text-muted-foreground">
        <Clock className="h-3 w-3" /> last probe {relTime(fetched.at)}
      </div>
      {fetched.error && <p className="mt-2 text-xs text-rose-500">{fetched.error}</p>}
    </div>
  );
}

function BackendStatusPage() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [live, setLive] = useState<Fetched<LiveResp>>({ data: null, error: null, loading: true, ms: 0, at: 0, code: null });
  const [ready, setReady] = useState<Fetched<ReadyResp>>({ data: null, error: null, loading: true, ms: 0, at: 0, code: null });
  const [mig, setMig] = useState<Fetched<MigResp>>({ data: null, error: null, loading: true, ms: 0, at: 0, code: null });
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const histRef = useRef<{ live: Probe[]; ready: Probe[]; mig: Probe[] }>({ live: [], ready: [], mig: [] });
  const [, forceRender] = useState(0);

  // Test-connection panel state
  type TestState = { status: "idle" | "running" | "ok" | "err"; ms?: number; message?: string; details?: string };
  const [test, setTest] = useState<TestState>({ status: "idle" });

  const authed = !!session;
  const token = session?.access_token;

  const refresh = async () => {
    if (!authed) return;
    setRefreshing(true);
    const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
    const [l, r, m] = await Promise.all([
      probe<LiveResp>("/livez", headers),
      probe<ReadyResp>("/readyz", headers),
      probe<MigResp>("/health/migrations", headers),
    ]);
    setLive(l); setReady(r); setMig(m);

    const push = (arr: Probe[], f: Fetched<any>, okStatus: (d: any) => boolean) => {
      arr.push({
        at: f.at, ms: f.ms, code: f.code,
        ok: !!f.data && okStatus(f.data),
      });
      while (arr.length > HISTORY_LIMIT) arr.shift();
    };
    push(histRef.current.live, l, d => d.status === "ok");
    push(histRef.current.ready, r, d => d.status === "ok" || d.status === "ready");
    push(histRef.current.mig, m, d => d.status === "ok");
    forceRender(x => x + 1);

    setLastUpdated(new Date());
    setRefreshing(false);
  };

  const testConnection = async () => {
    setTest({ status: "running" });
    const t0 = performance.now();
    try {
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      // /readyz requires DB + JWT check on backend — perfect authenticated smoke test
      const r = await fetch(`${API}/readyz`, { cache: "no-store", headers });
      const ms = Math.round(performance.now() - t0);
      const body = await r.text();
      if (!r.ok) {
        setTest({ status: "err", ms, message: `HTTP ${r.status}`, details: body.slice(0, 300) });
        return;
      }
      let parsed: any = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const okStatus = parsed?.status === "ok" || parsed?.status === "ready";
      setTest({
        status: okStatus ? "ok" : "err",
        ms,
        message: okStatus ? "Connection verified" : `Unexpected status: ${parsed?.status ?? "unknown"}`,
        details: JSON.stringify(parsed ?? { raw: body.slice(0, 200) }, null, 2),
      });
    } catch (e) {
      setTest({
        status: "err",
        ms: Math.round(performance.now() - t0),
        message: "Network error",
        details: (e as Error).message,
      });
    }
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
          Backend status is available to authenticated users only.
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

  const allOk = live.data?.status === "ok" && (ready.data?.status === "ok" || ready.data?.status === "ready") && mig.data?.status === "ok";

  return (
    <main className="mx-auto max-w-6xl p-6 md:p-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Backend Status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Probing <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{API}</code> every {REFRESH_MS / 1000}s · history keeps last {HISTORY_LIMIT} probes
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-xs text-muted-foreground">Updated {lastUpdated.toLocaleTimeString()}</span>}
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

      {/* Test connection panel */}
      <section className="mb-6 rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold text-foreground">Test connection</h2>
            <span className="text-xs text-muted-foreground">
              Auth-check against <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">{API}/readyz</code>
            </span>
          </div>
          <button
            onClick={testConnection}
            disabled={test.status === "running"}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {test.status === "running" ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
            {test.status === "running" ? "Testing…" : "Run test"}
          </button>
        </div>
        {test.status !== "idle" && test.status !== "running" && (
          <div className={`mt-4 rounded-lg border p-3 text-sm ${test.status === "ok" ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5"}`}>
            <div className="flex items-center justify-between">
              <span className={`font-medium ${test.status === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}>
                {test.status === "ok" ? "✓" : "✕"} {test.message}
              </span>
              <span className="text-xs text-muted-foreground">{test.ms} ms</span>
            </div>
            {test.details && (
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
                {test.details}
              </pre>
            )}
            <div className="mt-2 text-[11px] text-muted-foreground">
              Auth: {token ? "Bearer token attached" : "No token (anon probe)"} · Signed in as {(session as any)?.email ?? "—"}
            </div>
          </div>
        )}
      </section>

      {/* Per-endpoint cards with history + timings */}
      <div className="grid gap-4 md:grid-cols-3">
        <EndpointCard
          title="Liveness"
          icon={<Activity className="h-4 w-4 text-emerald-500" />}
          path="/livez"
          fetched={live}
          history={histRef.current.live}
        />
        <EndpointCard
          title="Readiness"
          icon={<Database className="h-4 w-4 text-blue-500" />}
          path="/readyz"
          fetched={ready}
          history={histRef.current.ready}
        />
        <EndpointCard
          title="Migrations"
          icon={<GitCommit className="h-4 w-4 text-violet-500" />}
          path="/health/migrations"
          fetched={mig}
          history={histRef.current.mig}
        />
      </div>

      {/* Readiness sub-checks */}
      {ready.data?.checks && (
        <section className="mt-6 rounded-xl border border-border bg-card p-5">
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-blue-500" />
            <h2 className="text-sm font-semibold">Readiness sub-checks</h2>
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {Object.entries(ready.data.checks).map(([name, c]) => (
              <li key={name} className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-sm">
                <span className="font-mono text-xs text-muted-foreground">{name}</span>
                <Badge ok={c.ok} label={c.ok ? `${c.latencyMs ?? "?"}ms` : (c.error ?? "fail")} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Migration deep detail */}
      {mig.data?.migrations && (
        <section className="mt-6 grid gap-4 md:grid-cols-3">
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <GitCommit className="h-4 w-4 text-violet-500" /> Migrations
            </div>
            <dl className="space-y-1 text-sm">
              <div className="flex justify-between"><dt className="text-muted-foreground">applied</dt><dd className="font-mono">{mig.data.migrations.count}</dd></div>
              <div className="flex justify-between"><dt className="text-muted-foreground">current</dt><dd className="truncate font-mono text-xs">{mig.data.migrations.current}</dd></div>
            </dl>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4 text-amber-500" /> audit_log integrity
            </div>
            <ul className="space-y-1 text-sm">
              <li className="flex justify-between"><span className="text-muted-foreground">columns</span><Badge ok={!!mig.data.audit_log_columns?.ok} label={`${mig.data.audit_log_columns?.present ?? 0} present`} /></li>
              <li className="flex justify-between"><span className="text-muted-foreground">FK</span><Badge ok={!!mig.data.audit_log_fk?.ok} label={mig.data.audit_log_fk?.ok ? "ok" : "missing"} /></li>
              <li className="flex justify-between"><span className="text-muted-foreground">indexes</span><Badge ok={!!mig.data.audit_log_indexes?.ok} label={`${mig.data.audit_log_indexes?.present?.length ?? 0}`} /></li>
            </ul>
          </div>
          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
              <Clock className="h-4 w-4 text-muted-foreground" /> Probe cadence
            </div>
            <p className="text-sm text-muted-foreground">
              Auto-refresh every <b className="text-foreground">{REFRESH_MS / 1000}s</b>. In-memory rolling history keeps the last <b className="text-foreground">{HISTORY_LIMIT}</b> probes per endpoint. External uptime monitoring runs via UptimeRobot — see <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">deploy/uptimerobot-monitors.sh</code>.
            </p>
          </div>
        </section>
      )}
    </main>
  );
}
