import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2, Send, PlayCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, scaling, type QueueJob, type QueueStat, type RateLimitPolicy, type RateLimitBucket } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/scaling")({
  component: ScalingPage,
});

// Scaling & Performance dashboard (Phase 17). Shows queue stats,
// recent jobs, workspace rate-limit policies, live throttle buckets,
// and a one-click test job + rate-limit harness for E2E verification.

function ScalingPage() {
  const [stats, setStats] = useState<QueueStat[]>([]);
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [policies, setPolicies] = useState<RateLimitPolicy[]>([]);
  const [snapshot, setSnapshot] = useState<RateLimitBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const [form, setForm] = useState({ route: "", scope: "ip" as const, max_hits: 100, window_sec: 60 });
  const [testForm, setTestForm] = useState({ route: "", identity: "dashboard-test", hits: 1 });
  const [echo, setEcho] = useState("");

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try {
      const [s, j, p, snap] = await Promise.all([
        scaling.stats(), scaling.jobs({ limit: 50 }),
        scaling.listRateLimits(), scaling.rateLimitStatus(),
      ]);
      setStats(s.rows); setJobs(j.jobs); setPolicies(p.policies); setSnapshot(snap.snapshot);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const addPolicy = async () => {
    if (!form.route) return;
    try { await scaling.upsertRateLimit({ ...form, action: "block" }); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const delPolicy = async (id: string) => { await scaling.deleteRateLimit(id); await load(); };

  const testPolicy = async () => {
    if (!testForm.route) return;
    try {
      const r = await scaling.testRateLimit({ route: testForm.route, identity: testForm.identity, hits: testForm.hits });
      setMsg(`${r.result.allowed ? "✓ allowed" : "✗ blocked"} — ${r.result.hits}/${r.result.max}, resets in ${r.result.reset_in_sec}s`);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };

  const enqueueTest = async () => {
    try {
      const r = await scaling.enqueueTest(echo || undefined);
      setMsg(`✓ enqueued ${r.id} on ${r.queue}`);
      setTimeout(() => void load(), 800);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };


  return (
    <div className="space-y-6">
      <PageHeader title="Scaling & Performance" description="Job queues, cache, and rate-limit policies"
        actions={<button onClick={() => void load()} disabled={loading}
          className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
        </button>} />

      {err && <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">{err}</div>}
      {msg && <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-500">{msg}</div>}

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Test the durable queue worker</div>
        <div className="text-xs text-muted-foreground">
          Enqueues a job on <code>pluto.test</code>. The in-process worker (PLUTO_QUEUE_WORKER=1) will echo it back and mark it done — refresh to see it appear below.
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs flex-1 min-w-[16rem]"><div className="text-muted-foreground">Echo payload (optional)</div>
            <input value={echo} onChange={(e) => setEcho(e.target.value)} placeholder="hello from dashboard"
              className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <button onClick={() => void enqueueTest()}
            className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">
            <PlayCircle className="h-4 w-4" /> Enqueue test job
          </button>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Test a rate-limit policy</div>
        <div className="text-xs text-muted-foreground">
          Increments the in-memory bucket for (route, identity) against the saved policy. Use it to verify a policy will actually throttle before shipping traffic.
        </div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs"><div className="text-muted-foreground">Route</div>
            <input value={testForm.route} onChange={(e) => setTestForm({ ...testForm, route: e.target.value })}
              placeholder="/auth/v1/token"
              className="mt-0.5 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Identity</div>
            <input value={testForm.identity} onChange={(e) => setTestForm({ ...testForm, identity: e.target.value })}
              className="mt-0.5 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Hits</div>
            <input type="number" min={1} value={testForm.hits}
              onChange={(e) => setTestForm({ ...testForm, hits: Number(e.target.value) })}
              className="mt-0.5 w-20 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <button onClick={() => void testPolicy()}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent">
            <Send className="h-4 w-4" /> Run
          </button>
        </div>
        {snapshot.length > 0 && (
          <div className="overflow-x-auto">
            <div className="text-xs text-muted-foreground mb-1">Live throttle buckets ({snapshot.length})</div>
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr><th className="py-1 pr-2">Key</th><th>Hits</th><th>Remaining</th><th>Blocked</th><th>Resets</th></tr>
              </thead>
              <tbody>
                {snapshot.map((t) => (
                  <tr key={t.key} className="border-t border-border/60">
                    <td className="py-1 pr-2 font-mono truncate max-w-[24rem]">{t.key}</td>
                    <td>{t.hits}/{t.max}</td>
                    <td className={t.remaining === 0 ? "text-rose-500" : ""}>{t.remaining}</td>
                    <td className={t.blocked > 0 ? "text-rose-500" : "text-muted-foreground"}>{t.blocked}</td>
                    <td className="text-muted-foreground">{t.reset_in_sec}s</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>


      <section className="rounded-lg border border-border bg-card p-4">
        <div className="font-semibold mb-3">Queue stats</div>
        <div className="grid gap-2 md:grid-cols-4">
          {stats.length === 0 && <div className="text-sm text-muted-foreground">No jobs yet.</div>}
          {stats.map((s) => (
            <div key={`${s.queue}:${s.status}`} className="rounded-md border border-border p-3">
              <div className="text-xs text-muted-foreground">{s.queue}</div>
              <div className="text-sm">{s.status}</div>
              <div className="text-2xl font-semibold">{s.n}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <div className="font-semibold mb-3">Recent jobs</div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="py-1">Queue</th><th>Status</th><th>Attempts</th><th>Run at</th><th>Error</th></tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-t border-border">
                  <td className="py-1.5">{j.queue}</td>
                  <td>{j.status}</td>
                  <td>{j.attempts}/{j.max_attempts}</td>
                  <td className="text-xs text-muted-foreground">{new Date(j.run_at).toLocaleString()}</td>
                  <td className="text-xs text-rose-500 truncate max-w-xs">{j.last_error ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="font-semibold">Rate-limit policies</div>
        <div className="flex flex-wrap gap-2 items-end">
          <label className="text-xs"><div className="text-muted-foreground">Route</div>
            <input value={form.route} onChange={(e) => setForm({ ...form, route: e.target.value })}
              placeholder="/auth/v1/token" className="mt-0.5 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Max hits</div>
            <input type="number" value={form.max_hits}
              onChange={(e) => setForm({ ...form, max_hits: Number(e.target.value) })}
              className="mt-0.5 w-24 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <label className="text-xs"><div className="text-muted-foreground">Window (sec)</div>
            <input type="number" value={form.window_sec}
              onChange={(e) => setForm({ ...form, window_sec: Number(e.target.value) })}
              className="mt-0.5 w-24 rounded-md border border-border bg-background px-2 py-1 text-sm" />
          </label>
          <button onClick={() => void addPolicy()}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm">Save</button>
        </div>
        <ul className="text-sm divide-y divide-border">
          {policies.map((p) => (
            <li key={p.id} className="py-2 flex items-center justify-between">
              <span className="font-mono text-xs">{p.route}</span>
              <span className="text-xs text-muted-foreground">{p.scope} · {p.max_hits}/{p.window_sec}s · {p.action}</span>
              <button onClick={() => void delPolicy(p.id)} className="text-rose-500"><Trash2 className="h-4 w-4" /></button>
            </li>
          ))}
          {policies.length === 0 && <li className="py-2 text-muted-foreground">No policies configured.</li>}
        </ul>
      </section>
    </div>
  );
}
