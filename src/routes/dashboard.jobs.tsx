import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, subscribe, type JobToken, type RealtimeEvent } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/jobs")({
  component: JobsPage,
});

const TTL_PRESETS = [
  { label: "1 day", value: 86400 },
  { label: "7 days", value: 86400 * 7 },
  { label: "30 days", value: 86400 * 30 },
  { label: "90 days", value: 86400 * 90 },
];

type Toast = { id: string; text: string; kind: "info" | "warn" };

function JobsPage() {
  const [tokens, setTokens] = useState<JobToken[] | null>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState("");
  const [ttl, setTtl] = useState(86400 * 7);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [liveConn, setLiveConn] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) { setTokens([]); setErr("Backend not configured."); return; }
      setTokens(await live.jobs.list());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live: react to job_token.* audit events so revocations from other
  // admin sessions surface immediately.
  useEffect(() => {
    if (!isLive()) return;
    setLiveConn(true);
    const off = subscribe("system:audit", (e: RealtimeEvent) => {
      if (!e.event.startsWith("job_token.")) return;
      const p = (e.payload ?? {}) as { actor_email?: string; target?: string; metadata?: { name?: string } };
      const label = e.event === "job_token.mint" ? "minted" : "revoked";
      const text = `${p.actor_email ?? "admin"} ${label} ${p.metadata?.name ?? p.target ?? "token"}`;
      setToasts((prev) => [{ id: Math.random().toString(36).slice(2), text, kind: "warn" as const }, ...prev].slice(0, 5));
      void load();
    });
    return () => { off(); setLiveConn(false); };
  }, [load]);

  async function mint() {
    if (!name.trim()) return;
    setBusy(true); setErr(null);
    try {
      if (!isLive()) throw new Error("Pluto backend not configured.");
      const scopes = scope.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await live.jobs.mint(name.trim(), scopes, ttl);
      setNewSecret(res.token);
      setName(""); setScope("");
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function revoke(id: string) {
    if (!confirm("Revoke this token? Workers using it will fail immediately.")) return;
    try { await live.jobs.revoke(id); await load(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div>
      <PageHeader
        title="Pool user & job tokens"
        description="Server-side workers run as the dedicated pluto_jobs Postgres role (BYPASSRLS). Mint scoped, expiring tokens instead of sharing the service-role key."
      />

      {isLive() && (
        <div className="mb-3 text-xs inline-flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${liveConn ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
          <span className={liveConn ? "text-emerald-500" : "text-muted-foreground"}>{liveConn ? "live audit stream" : "connecting…"}</span>
        </div>
      )}
      {toasts.length > 0 && (
        <div className="mb-4 space-y-1.5">
          {toasts.map((t) => (
            <div key={t.id} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400 flex items-center justify-between gap-2">
              <span><AlertTriangle className="inline h-3 w-3 mr-1" />{t.text}</span>
              <button onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))} className="text-muted-foreground hover:text-foreground">×</button>
            </div>
          ))}
        </div>
      )}

      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <h2 className="font-medium text-sm">How this works</h2>
        </div>
        <ul className="text-xs text-muted-foreground list-disc ml-5 space-y-1">
          <li>Workers authenticate with <code>X-Job-Token: pjt_…</code> against <code>/jobs/v1/exec</code> or <code>/jobs/v1/rpc/&lt;job&gt;</code>.</li>
          <li>The server exchanges the token for a connection on the dedicated <code>pluto_jobs</code> pool — RLS is bypassed but privileges stay minimal.</li>
          <li>The service-role key never leaves the backend; clients only ever see short-lived job tokens.</li>
          <li>Scope narrows a token to a whitelist of named jobs (empty scope = <code>/exec</code> only).</li>
        </ul>
      </div>

      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <h2 className="font-medium text-sm mb-3">Mint a new job token</h2>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="nightly-billing-rollup"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Scope (comma-separated job names, blank = /exec only)</label>
            <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="rollup_invoices, send_receipts"
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Lifetime</label>
            <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
              {TTL_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </div>
        </div>
        <button disabled={busy || !isLive()} onClick={mint}
          className="mt-4 inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50">
          <KeyRound className="h-4 w-4" /> Mint token
        </button>
        {!isLive() && (
          <span className="ml-3 text-xs text-muted-foreground inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Configure VITE_PLUTO_URL to mint real tokens
          </span>
        )}
        {err && <div className="mt-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{err}</div>}
      </div>

      {newSecret && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-amber-600 dark:text-amber-400">Copy this token now — it is shown only once.</div>
              <code className="text-xs break-all">{newSecret}</code>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => navigator.clipboard.writeText(newSecret)}
                className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent">
                <Copy className="h-3 w-3" /> Copy
              </button>
              <button onClick={() => setNewSecret(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            </div>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Name</th>
              <th className="text-left px-3 py-2 font-medium">Scope</th>
              <th className="text-left px-3 py-2 font-medium">Expires</th>
              <th className="text-left px-3 py-2 font-medium">Uses</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(tokens ?? []).map((t) => {
              const revoked = !!t.revoked_at;
              const expired = new Date(t.expires_at).getTime() < Date.now();
              return (
                <tr key={t.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <div className="font-medium">{t.name}</div>
                    <div className="text-xs text-muted-foreground">{revoked ? "revoked" : expired ? "expired" : "active"}</div>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {t.scope.length ? t.scope.map((s) => (
                      <span key={s} className="inline-block rounded-md border border-border px-1.5 py-0.5 mr-1 mb-1">{s}</span>
                    )) : <span className="text-muted-foreground">/exec only</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{new Date(t.expires_at).toLocaleString()}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{t.use_count}</td>
                  <td className="px-3 py-2 text-right">
                    {!revoked && (
                      <button onClick={() => revoke(t.id)}
                        className="inline-flex items-center gap-1 rounded-md border border-red-500/40 text-red-500 px-2 py-1 text-xs hover:bg-red-500/10">
                        <Trash2 className="h-3 w-3" /> Revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {tokens && tokens.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground" colSpan={5}>No tokens yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
