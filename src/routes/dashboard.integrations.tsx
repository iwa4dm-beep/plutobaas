import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { integrations, isLive, type IntegrationHealth } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/integrations")({
  component: IntegrationsPage,
});

// ============================================================
// Integration health — Phase 15/16 module readiness
// ------------------------------------------------------------
// Calls GET /admin/v1/integrations/health and renders per-module
// enable flags, DB permissions, and provider readiness. All
// checks are performed server-side; this page just visualises.
// ============================================================

function StatusPill({ ok, enabled }: { ok: boolean; enabled: boolean }) {
  if (!enabled) return <span className="text-xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">Disabled</span>;
  return ok
    ? <span className="text-xs rounded-full bg-emerald-500/15 text-emerald-500 px-2 py-0.5">Ready</span>
    : <span className="text-xs rounded-full bg-rose-500/15 text-rose-500 px-2 py-0.5">Not ready</span>;
}

function IntegrationsPage() {
  const [data, setData] = useState<IntegrationHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Dashboard is running in mock mode (VITE_PLUTO_URL not set)."); return; }
    setLoading(true); setErr(null);
    try { setData(await integrations.health()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Integration health"
        description="Live readiness for Phase 15 & 16 modules (MFA, SSO, Push, Templates, AI & Vector)"
        actions={
          <button onClick={() => void load()} disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-60">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
          </button>
        }
      />

      {err && (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/5 px-4 py-3 text-sm text-rose-500">
          {err}
        </div>
      )}

      {data && (
        <>
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm flex items-center justify-between">
            <div className="flex items-center gap-2">
              {data.ok
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : <XCircle className="h-4 w-4 text-rose-500" />}
              <span className="font-medium">Overall: {data.ok ? "healthy" : "attention needed"}</span>
            </div>
            <span className="text-xs text-muted-foreground">Generated {new Date(data.generated_at).toLocaleString()}</span>
          </div>

          {data.modules.length === 0 && (
            <div className="rounded-md border border-border bg-card px-4 py-6 text-sm text-muted-foreground text-center">
              No integration modules are registered on this backend. Enable Phase 15/16 modules (MFA, SSO, Push, Templates, AI, Vector) on the server to see readiness here.
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            {data.modules.map((m) => (
              <div key={m.module} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="font-semibold">{m.module}</div>
                  <StatusPill ok={m.ready} enabled={m.enabled} />
                </div>
                <div className="text-xs text-muted-foreground font-mono">{m.env_flag}</div>
                <ul className="space-y-1.5 text-sm">
                  {m.checks.map((c) => (
                    <li key={c.name} className="flex items-start gap-2">
                      {c.ok
                        ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                        : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />}
                      <div>
                        <div>{c.name}</div>
                        {c.detail && <div className="text-xs text-muted-foreground">{c.detail}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
                {m.endpoints.length > 0 && (
                  <details className="text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Endpoints ({m.endpoints.length})</summary>
                    <ul className="mt-1 space-y-0.5 font-mono">
                      {m.endpoints.map((e) => <li key={e} className="text-muted-foreground">{e}</li>)}
                    </ul>
                  </details>
                )}
                {m.throttle && m.throttle.length > 0 && (
                  <details className="text-xs" open>
                    <summary className="cursor-pointer text-muted-foreground">
                      Per-key throttle status ({m.throttle.length})
                    </summary>
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead className="text-left text-muted-foreground">
                          <tr><th className="py-1 pr-2">Key</th><th>Hits</th><th>Remaining</th><th>Blocked</th><th>Resets</th></tr>
                        </thead>
                        <tbody>
                          {m.throttle.map((t) => (
                            <tr key={t.key} className="border-t border-border/60">
                              <td className="py-1 pr-2 font-mono truncate max-w-[16rem]">{t.key}</td>
                              <td>{t.hits}/{t.max}</td>
                              <td className={t.remaining === 0 ? "text-rose-500" : ""}>{t.remaining}</td>
                              <td className={t.blocked > 0 ? "text-rose-500" : "text-muted-foreground"}>{t.blocked}</td>
                              <td className="text-muted-foreground">{t.reset_in_sec}s</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}

              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
