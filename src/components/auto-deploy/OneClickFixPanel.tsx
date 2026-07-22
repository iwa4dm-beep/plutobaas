// One-click VPS repair panel — surfaces on Auto-Deploy Studio and triggers
// whitelisted shell scripts on the VPS via the sandbox worker's authenticated
// /admin/repair endpoint. Also runs a preflight-and-heal probe for
// API/migrations, worker 404, and wildcard SSL before you deploy.
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  Wrench, Activity, ShieldCheck, Server, Globe2, Loader2, CheckCircle2, XCircle,
  RefreshCw, Rocket, Zap, AlertTriangle, Calendar, Layers,
} from "lucide-react";
import {
  runVpsRepair, preflightAndHeal, getSlugCertStatus, batchIssuePerSlugCerts,
  diagnoseRepairChannel,
  type RepairAction, type RepairResult, type PreflightHealResult,
  type SlugCertStatus, type BatchIssueResult, type RepairChannelDiagnostic,
} from "@/lib/pluto/vps-repair.functions";

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
  "primary-frontend": { label: "Activate primary frontend", icon: Globe2, hint: "Flip app.timescard.app to the latest deployed release without creating a new subdomain/cert." },
  "deploy-and-verify": { label: "Redeploy API + verify", icon: Rocket, hint: "Rebuild pluto-api container, restart, run migrations, probe /admin/v1/health." },
  "set-upstream": { label: "Fix worker upstream URL", icon: Server, hint: "Rewrite PLUTO_UPSTREAM_URL in the VPS worker env — use the form below (needs a real Supabase URL)." },
  "all": { label: "Run all (auto-heal)", icon: Zap, hint: "Sequence worker+site → primary frontend → redeploy+verify." },
};

const AUTOHEAL_KEY = "pluto:auto-heal-before-deploy";

export function OneClickFixPanel({ slug, wildcard, acmeEmail, onAutoHealChange }: Props) {
  const [busy, setBusy] = useState<RepairAction | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [results, setResults] = useState<Record<string, RepairResult>>({});
  const [preflight, setPreflight] = useState<PreflightHealResult | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [certStatus, setCertStatus] = useState<SlugCertStatus | null>(null);
  const [certBusy, setCertBusy] = useState(false);
  const [batchInput, setBatchInput] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResults, setBatchResults] = useState<BatchIssueResult[] | null>(null);
  const [upstreamInput, setUpstreamInput] = useState("");
  const runRepair = useServerFn(runVpsRepair);
  const runPreflight = useServerFn(preflightAndHeal);
  const fetchCertStatus = useServerFn(getSlugCertStatus);
  const runBatch = useServerFn(batchIssuePerSlugCerts);

  useEffect(() => {
    try { setAutoHeal(localStorage.getItem(AUTOHEAL_KEY) === "1"); } catch { /* SSR */ }
  }, []);

  // Auto-load cert status whenever `slug` prop changes.
  useEffect(() => {
    if (!slug) { setCertStatus(null); return; }
    let cancelled = false;
    setCertBusy(true);
    fetchCertStatus({ data: { slug, wildcard } })
      .then((r) => { if (!cancelled) setCertStatus(r); })
      .catch((e) => { if (!cancelled) setCertStatus({ ok: false, fqdn: `${slug}.${wildcard || "app.timescard.app"}`, exists: false, source: null, error: (e as Error).message }); })
      .finally(() => { if (!cancelled) setCertBusy(false); });
    return () => { cancelled = true; };
  }, [slug, wildcard, fetchCertStatus]);

  const refreshCert = useCallback(async () => {
    if (!slug) return;
    setCertBusy(true);
    try {
      const r = await fetchCertStatus({ data: { slug, wildcard } });
      setCertStatus(r);
    } catch (e) { toast.error(`Cert status failed: ${(e as Error).message}`); }
    finally { setCertBusy(false); }
  }, [fetchCertStatus, slug, wildcard]);

  const parsedBatchSlugs = batchInput
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(s));

  const runBatchIssue = useCallback(async () => {
    if (parsedBatchSlugs.length === 0) { toast.error("Enter at least one valid slug"); return; }
    setBatchBusy(true);
    setBatchResults(null);
    try {
      const r = await runBatch({ data: { slugs: parsedBatchSlugs, wildcard, acmeEmail } });
      setBatchResults(r.results);
      const okCount = r.results.filter((x) => x.ok).length;
      const failCount = r.results.length - okCount;
      if (failCount === 0) toast.success(`Batch: ${okCount}/${r.results.length} certs issued`);
      else toast.warning(`Batch: ${okCount} ok, ${failCount} failed — expand rows for details`);
    } catch (e) { toast.error(`Batch failed: ${(e as Error).message}`); }
    finally { setBatchBusy(false); }
  }, [runBatch, parsedBatchSlugs, wildcard, acmeEmail]);

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

  const doRepair = useCallback(async (action: RepairAction, extra?: { upstream?: string }) => {
    setBusy(action);
    try {
      const r = await runRepair({ data: { action, slug, wildcard, acmeEmail, upstream: extra?.upstream } });
      setResults((prev) => ({ ...prev, [action]: r }));
      if (r.ok) toast.success(`${ACTION_LABELS[action].label} — ok (${r.durationMs}ms)`);
      else toast.error(`${ACTION_LABELS[action].label} — failed (exit ${r.exitCode})`);
    } catch (e) { toast.error(`${ACTION_LABELS[action].label} failed: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }, [runRepair, slug, wildcard, acmeEmail]);

  const parsedUpstream = upstreamInput.trim();
  const upstreamValid =
    /^https?:\/\/[A-Za-z0-9._-]+(:\d+)?(\/.*)?$/.test(parsedUpstream) &&
    !/<[^>]+>|your-project|example\.com|placeholder|supabase-ref/i.test(parsedUpstream);
  const doSetUpstream = useCallback(() => {
    if (!upstreamValid) { toast.error("Enter a real https://…supabase.co URL (no placeholders)"); return; }
    doRepair("set-upstream", { upstream: parsedUpstream });
  }, [doRepair, upstreamValid, parsedUpstream]);

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

        {/* Per-slug SSL cert status */}
        {slug && (
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-medium">SSL cert status</div>
              <span className="ml-2 text-[11px] text-muted-foreground font-mono truncate">
                {certStatus?.fqdn || `${slug}.${wildcard || "app.timescard.app"}`}
              </span>
              <button
                onClick={refreshCert}
                disabled={certBusy}
                className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent disabled:opacity-50"
              >
                {certBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Refresh
              </button>
            </div>
            {certStatus && (
              <div className="mt-2 text-xs">
                {!certStatus.exists ? (
                  <div className="flex items-start gap-2 rounded-md bg-amber-500/10 border border-amber-500/30 p-2 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <span>{certStatus.error || certStatus.hint || "No certificate on disk yet. Click 'Issue per-slug HTTP-01 cert' below."}</span>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                    <div className="text-muted-foreground">Source</div>
                    <div className="font-mono">{certStatus.source}{certStatus.coversFqdn === false && <span className="ml-1 text-destructive">(does not cover FQDN)</span>}</div>
                    <div className="text-muted-foreground">Issued</div>
                    <div className="font-mono">{certStatus.notBefore ? new Date(certStatus.notBefore).toLocaleString() : "—"}</div>
                    <div className="text-muted-foreground">Expires</div>
                    <div className="font-mono">
                      {certStatus.notAfter ? new Date(certStatus.notAfter).toLocaleString() : "—"}
                      {typeof certStatus.daysLeft === "number" && (
                        <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] ${
                          certStatus.daysLeft < 15 ? "bg-destructive/15 text-destructive"
                          : certStatus.daysLeft < 30 ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                        }`}>{certStatus.daysLeft}d left</span>
                      )}
                    </div>
                    <div className="text-muted-foreground">Issuer</div>
                    <div className="font-mono truncate" title={certStatus.issuer}>{certStatus.issuer || "—"}</div>
                    {certStatus.hint && (
                      <>
                        <div className="text-muted-foreground">Hint</div>
                        <div className="text-amber-600 dark:text-amber-400">{certStatus.hint}</div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Batch per-slug HTTP-01 issuance */}
        <div className="rounded-lg border border-border bg-background/60 p-3">
          <div className="flex items-center gap-2">
            <Layers className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm font-medium">Batch: per-slug HTTP-01 certs</div>
            <span className="ml-auto text-[11px] text-muted-foreground">
              {parsedBatchSlugs.length} valid slug{parsedBatchSlugs.length === 1 ? "" : "s"} (max 25)
            </span>
          </div>
          <textarea
            value={batchInput}
            onChange={(e) => setBatchInput(e.target.value)}
            placeholder="Paste slugs — one per line, or comma/space separated (e.g. dubaiborkahouse-tzsegx, frfrom-he3wm0)"
            rows={3}
            className="mt-2 w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono resize-y focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={runBatchIssue}
              disabled={batchBusy || parsedBatchSlugs.length === 0 || busy !== null}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {batchBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              Issue {parsedBatchSlugs.length || ""} cert{parsedBatchSlugs.length === 1 ? "" : "s"}
            </button>
            {batchResults && (
              <button
                onClick={() => { setBatchResults(null); setBatchInput(""); }}
                className="text-[11px] text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
          {batchResults && (
            <ul className="mt-3 space-y-1 text-xs">
              {batchResults.map((r) => (
                <li key={r.slug} className="rounded-md border border-border p-2">
                  <details>
                    <summary className="flex items-center gap-2 cursor-pointer">
                      {r.ok
                        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                        : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                      <span className="font-mono">{r.slug}</span>
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        exit {r.exitCode} · {r.durationMs}ms
                      </span>
                    </summary>
                    {r.hint && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{r.hint}</p>}
                    <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">{r.tail || "(no output)"}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Fix worker upstream URL (PLUTO_UPSTREAM_URL placeholder → real Supabase URL) */}
        <div className="rounded-lg border border-border bg-background/60 p-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-muted-foreground" />
            <div className="text-sm font-medium">Fix worker upstream URL</div>
            {results["set-upstream"] && (
              <span className="ml-auto">
                {results["set-upstream"].ok
                  ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  : <XCircle className="h-4 w-4 text-destructive" />}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Rewrites <code className="font-mono">PLUTO_UPSTREAM_URL</code> in the VPS worker's env file and
            restarts the sandbox worker. Use this when <code className="font-mono">/healthz</code> shows a
            placeholder like <code className="font-mono">&lt;supabase-ref&gt;.supabase.co</code>.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="url"
              value={upstreamInput}
              onChange={(e) => setUpstreamInput(e.target.value)}
              placeholder="https://abcd1234.supabase.co"
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={doSetUpstream}
              disabled={busy !== null || !upstreamValid}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy === "set-upstream" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wrench className="h-3.5 w-3.5" />}
              Apply & restart worker
            </button>
          </div>
          {upstreamInput && !upstreamValid && (
            <p className="mt-1 text-[11px] text-destructive">Must be a real https://…supabase.co URL — no placeholders.</p>
          )}
          {results["set-upstream"] && (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] text-muted-foreground">
                exit {results["set-upstream"].exitCode} · {results["set-upstream"].durationMs}ms · {results["set-upstream"].tail.length} bytes
              </summary>
              {results["set-upstream"].hint && <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{results["set-upstream"].hint}</p>}
              <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 text-[11px] whitespace-pre-wrap">{results["set-upstream"].tail || "(no output)"}</pre>
            </details>
          )}
        </div>

        {/* Repair action buttons */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(Object.keys(ACTION_LABELS) as RepairAction[]).filter((a) => a !== "set-upstream").map((action) => {
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
