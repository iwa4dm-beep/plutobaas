// One-click VPS repair panel — surfaces on Auto-Deploy Studio and triggers
// whitelisted shell scripts on the VPS via the sandbox worker's authenticated
// /admin/repair endpoint. Also runs a preflight-and-heal probe for
// API/migrations, worker 404, and wildcard SSL before you deploy.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Wrench, Activity, ShieldCheck, Server, Globe2, Loader2, CheckCircle2, XCircle,
  RefreshCw, Rocket, Zap, AlertTriangle,
} from "lucide-react";
import { runVpsRepair, preflightAndHeal, type RepairAction, type RepairResult, type PreflightHealResult } from "@/lib/pluto/vps-repair.functions";

type Props = {
  slug?: string;
  wildcard?: string;
  acmeEmail?: string;
  onAutoHealChange?: (enabled: boolean) => void;
};

const ACTION_LABELS: Record<RepairAction, { label: string; icon: React.ComponentType<{ className?: string }>; hint: string }> = {
  "worker-and-site": { label: "Repair worker + site", icon: Server, hint: "Restart pluto-sandbox-worker, free port 8787, rebuild slug symlinks." },
  "wildcard-ssl": { label: "Fix wildcard SSL", icon: ShieldCheck, hint: "Issue/renew *.<wildcard> Let's Encrypt cert via DNS-01, reload nginx." },
  "per-slug-ssl": { label: "Issue per-slug HTTP-01 cert", icon: Globe2, hint: "Single-subdomain Let's Encrypt cert via HTTP-01 webroot — works without Cloudflare/DNS-API." },
  "deploy-and-verify": { label: "Redeploy API + verify", icon: Rocket, hint: "Rebuild pluto-api container, restart, run migrations, probe /admin/v1/health." },
  "all": { label: "Run all (auto-heal)", icon: Zap, hint: "Sequence worker+site → wildcard SSL → redeploy+verify." },
};

const AUTOHEAL_KEY = "pluto:auto-heal-before-deploy";

export function OneClickFixPanel({ slug, wildcard, acmeEmail, onAutoHealChange }: Props) {
  const [busy, setBusy] = useState<RepairAction | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [results, setResults] = useState<Record<string, RepairResult>>({});
  const [preflight, setPreflight] = useState<PreflightHealResult | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const runRepair = useServerFn(runVpsRepair);
  const runPreflight = useServerFn(preflightAndHeal);

  useEffect(() => {
    try { setAutoHeal(localStorage.getItem(AUTOHEAL_KEY) === "1"); } catch { /* SSR */ }
  }, []);

  const toggleAutoHeal = useCallback((next: boolean) => {
    setAutoHeal(next);
    try { localStorage.setItem(AUTOHEAL_KEY, next ? "1" : "0"); } catch { /* SSR */ }
    onAutoHealChange?.(next);
  }, [onAutoHealChange]);

  const doPreflight = useCallback(async () => {
    setPreflightBusy(true);
    try {
      const r = await runPreflight({ data: { slug, wildcard } });
      setPreflight(r);
      const failing = r.suggestions.length;
      if (failing === 0) toast.success("Preflight: all systems healthy");
      else toast.warning(`Preflight found ${failing} issue${failing === 1 ? "" : "s"} — suggested repairs highlighted`);
    } catch (e) { toast.error(`Preflight failed: ${(e as Error).message}`); }
    finally { setPreflightBusy(false); }
  }, [runPreflight, slug, wildcard]);

  const doRepair = useCallback(async (action: RepairAction) => {
    setBusy(action);
    try {
      const r = await runRepair({ data: { action, slug, wildcard, acmeEmail } });
      setResults((prev) => ({ ...prev, [action]: r }));
      if (r.ok) toast.success(`${ACTION_LABELS[action].label} — ok (${r.durationMs}ms)`);
      else toast.error(`${ACTION_LABELS[action].label} — failed (exit ${r.exitCode})`);
    } catch (e) { toast.error(`${ACTION_LABELS[action].label} failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }, [runRepair, slug, wildcard, acmeEmail]);

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 flex items-center gap-2">
        <Wrench className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-medium">One-click VPS repair</h3>
        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <label className="inline-flex items-center gap-1.5 cursor-pointer">
            <input
              type="checkbox"
              checked={autoHeal}
              onChange={(e) => toggleAutoHeal(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border accent-primary"
            />
            Auto-heal before deploy
          </label>
        </span>
      </div>

      <div className="p-4 space-y-4">
        {/* Preflight probe */}
        <div className="rounded-lg border border-border bg-background/60 p-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm font-medium">Preflight probe</div>
            <button
              onClick={doPreflight}
              disabled={preflightBusy}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
            >
              {preflightBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Run preflight
            </button>
          </div>
          {preflight && (
            <ul className="mt-2 space-y-1 text-xs">
              <PreflightRow label="API / migrations" icon={Server}
                ok={preflight.api.ok} detail={`HTTP ${preflight.api.status} — ${preflight.api.detail}`} />
              <PreflightRow label="Sandbox worker" icon={Server}
                ok={preflight.worker.ok} detail={`HTTP ${preflight.worker.status} — ${preflight.worker.detail}`} />
              {slug && (
                <PreflightRow label={`Served site (${slug})`} icon={Globe2}
                  ok={preflight.slug404.ok} detail={`HTTP ${preflight.slug404.status} — ${preflight.slug404.url}`} />
              )}
              <PreflightRow label="Wildcard SSL" icon={ShieldCheck}
                ok={preflight.ssl.ok} detail={preflight.ssl.detail} />
              {preflight.suggestions.length > 0 && (
                <li className="mt-2 flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <span>
                    Suggested repairs: <span className="font-mono">{preflight.suggestions.join(", ")}</span>
                    {" — "}or click <b>Run all</b> to auto-heal.
                  </span>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Repair action buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(Object.keys(ACTION_LABELS) as RepairAction[]).map((action) => {
            const meta = ACTION_LABELS[action];
            const Icon = meta.icon;
            const r = results[action];
            const highlight = preflight?.suggestions.includes(action);
            const isBusy = busy === action;
            return (
              <button
                key={action}
                onClick={() => doRepair(action)}
                disabled={busy !== null}
                className={`text-left rounded-lg border p-3 transition disabled:opacity-50 disabled:cursor-not-allowed ${
                  highlight ? "border-amber-500/50 bg-amber-500/5 hover:bg-amber-500/10"
                    : action === "all" ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                    : "border-border hover:bg-accent/40"
                }`}
              >
                <div className="flex items-center gap-2">
                  {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
                  <span className="text-sm font-medium">{meta.label}</span>
                  {r && (
                    <span className="ml-auto">
                      {r.ok ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <XCircle className="h-4 w-4 text-destructive" />}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{meta.hint}</p>
                {r && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">
                      exit {r.exitCode} · {r.durationMs}ms · {r.tail.length} bytes
                    </summary>
                    {r.hint && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{r.hint}</p>}
                    <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">{r.tail || "(no output)"}</pre>
                  </details>
                )}
              </button>
            );
          })}
        </div>

        <p className="text-[11px] text-muted-foreground">
          Requires the sandbox worker on the VPS to have <code className="font-mono">/usr/local/sbin/pluto-repair</code> installed
          (run <code className="font-mono">sudo bash pluto-backend/deploy/full-deploy.sh</code> once to install it and the sudoers rule).
        </p>
      </div>
    </section>
  );
}

function PreflightRow({ label, icon: Icon, ok, detail }: { label: string; icon: React.ComponentType<{ className?: string }>; ok: boolean; detail: string }) {
  return (
    <li className="flex items-start gap-2">
      <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5 text-muted-foreground" />
      <span className="w-40 shrink-0">{label}</span>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-0.5" /> : <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />}
      <span className="text-muted-foreground truncate" title={detail}>{detail}</span>
    </li>
  );
}
