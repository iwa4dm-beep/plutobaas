import { useEffect, useMemo, useState } from "react";
import { Lightbulb, AlertTriangle, XCircle, Info, X, ExternalLink } from "lucide-react";
import type { DeployAllResult, SslProbe, LiveUrlProbe } from "@/lib/pluto/vps-deployer.functions";
import { loadDeploymentSettings, saveDeploymentSettings, type DeploymentSettings } from "@/lib/pluto/deployment-settings";

type Severity = "info" | "warn" | "critical";

interface Recommendation {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
  href?: string;
}

const DISMISS_KEY = (ws: string) => `pluto:reco-dismissed:${ws || "root"}`;

function loadDismissed(ws: string): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(DISMISS_KEY(ws)) || "{}");
  } catch {
    return {};
  }
}
function saveDismissed(ws: string, v: Record<string, number>) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(DISMISS_KEY(ws), JSON.stringify(v)); } catch { /* ignore */ }
}

function computeRecommendations(
  result: DeployAllResult | null,
  settings: DeploymentSettings,
  applySetting: (patch: Partial<DeploymentSettings>) => void,
): Recommendation[] {
  const recs: Recommendation[] = [];
  if (!result) return recs;

  const ssl = (result.liveUrls as { sslProbe?: SslProbe } | undefined)?.sslProbe;
  const servedProbe = (result.liveUrls as { servedSiteProbe?: LiveUrlProbe } | undefined)?.servedSiteProbe;
  const servedHint = result.liveUrls?.servedHint;
  const stepBy = Object.fromEntries(result.steps.map((s) => [s.key, s] as const));

  // SSL expiring
  const days = ssl?.cert?.daysUntilExpiry ?? null;
  if (days != null && days <= 30) {
    recs.push({
      id: "ssl-expiring",
      severity: days <= 7 ? "critical" : "warn",
      title: `SSL certificate expires in ${days} day${days === 1 ? "" : "s"}`,
      detail:
        "Renew the wildcard certificate before it expires. On the VPS, run `sudo bash pluto-backend/deploy/fix-wildcard-ssl.sh <slug>` — the cert-renew timer should also cover this automatically.",
    });
  }

  // SSL hostname mismatch
  if (ssl?.cert?.hostnameMatch === false) {
    recs.push({
      id: "ssl-hostname-mismatch",
      severity: "critical",
      title: "SSL hostname does not match served site",
      detail: "The wildcard cert doesn't cover this slug's host. Re-issue the wildcard cert and reload nginx.",
    });
  }

  // Served site failing or returning 2xx for the wrong upstream app.
  if (servedProbe && !servedProbe.reachable) {
    const routeMismatch = servedProbe.httpOk === true;
    recs.push({
      id: "served-site-bad",
      severity: "warn",
      title: routeMismatch
        ? `Served site returned HTTP ${servedProbe.status}, but the deployed app is not routed`
        : `Served site returned HTTP ${servedProbe.status || "000"}`,
      detail: servedHint || (routeMismatch
        ? `The hostname is reachable, but route validation failed (${servedProbe.routeMismatchReason ?? "wrong app"}). Run One-click Fix → Activate primary frontend.`
        : "Bundle may be unpacked but not routed. Open the Diagnose served-site panel above, or check nginx sites-proxy + DNS wildcard."),
    });
  }

  // Strict served-site off but warnings present
  if (!settings.strictServedSite && servedProbe && !servedProbe.reachable) {
    recs.push({
      id: "enable-strict-served",
      severity: "info",
      title: "Consider enabling Strict served-site",
      detail: "Warnings are currently non-fatal. Enable Strict mode in Settings to fail deploys when the site isn't served.",
      actionLabel: "Enable Strict served-site",
      onAction: () => applySetting({ strictServedSite: true }),
    });
  }

  // Notify email missing
  if (!settings.notifyEmail.trim()) {
    recs.push({
      id: "notify-email-missing",
      severity: "info",
      title: "No notification email set",
      detail: "Add an email in Deployment Settings to receive deploy status alerts.",
    });
  }

  // Migrations failed
  const mig = stepBy["push-migrations"];
  if (mig && !mig.ok) {
    recs.push({
      id: "migrations-failed",
      severity: "critical",
      title: "Database migrations failed",
      detail: mig.result || "Check the Build Logs panel and the migrations console for the failing statement.",
    });
  }

  // Health check warn
  const health = stepBy["health-check"];
  if (health && !health.ok) {
    recs.push({
      id: "health-warn",
      severity: "warn",
      title: "Health probes reported issues",
      detail: health.result || "Review the health check output; a stale worker version may need a refresh.",
    });
  }

  return recs;
}

function severityIcon(s: Severity) {
  if (s === "critical") return <XCircle className="h-4 w-4 text-destructive" />;
  if (s === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  return <Info className="h-4 w-4 text-sky-500" />;
}

export function RecommendationsPanel({
  result,
  workspaceId,
}: {
  result: DeployAllResult | null;
  workspaceId: string;
}) {
  const [settings, setSettings] = useState<DeploymentSettings>(() => loadDeploymentSettings(workspaceId));
  const [dismissed, setDismissed] = useState<Record<string, number>>(() => loadDismissed(workspaceId));

  useEffect(() => {
    setSettings(loadDeploymentSettings(workspaceId));
    setDismissed(loadDismissed(workspaceId));
    if (typeof window === "undefined") return;
    const h = () => setSettings(loadDeploymentSettings(workspaceId));
    window.addEventListener("pluto:deployment-settings:changed", h);
    return () => window.removeEventListener("pluto:deployment-settings:changed", h);
  }, [workspaceId]);

  const applySetting = (patch: Partial<DeploymentSettings>) => {
    const next = { ...loadDeploymentSettings(workspaceId), ...patch };
    saveDeploymentSettings(workspaceId, next);
    setSettings(next);
  };

  const recs = useMemo(
    () => computeRecommendations(result, settings, applySetting),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, settings],
  );

  const visible = recs.filter((r) => !dismissed[r.id]);

  const dismiss = (id: string) => {
    const next = { ...dismissed, [id]: Date.now() };
    setDismissed(next);
    saveDismissed(workspaceId, next);
  };

  const resetDismissed = () => {
    setDismissed({});
    saveDismissed(workspaceId, {});
  };

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4" /> Recommendations
          <span className="ml-2 text-xs text-muted-foreground">
            {visible.length} active · {Object.keys(dismissed).length} dismissed
          </span>
        </span>
        {Object.keys(dismissed).length > 0 && (
          <button
            onClick={resetDismissed}
            className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
          >
            Show dismissed
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <div className="px-4 py-6 text-xs text-muted-foreground text-center">
          {result ? "No recommendations — everything looks healthy." : "Run a deploy to see recommendations."}
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {visible.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3 text-xs">
              <span className="mt-0.5">{severityIcon(r.severity)}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{r.title}</div>
                <div className="text-muted-foreground mt-0.5">{r.detail}</div>
                {(r.actionLabel || r.href) && (
                  <div className="mt-1.5 flex gap-2">
                    {r.actionLabel && r.onAction && (
                      <button
                        onClick={r.onAction}
                        className="rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
                      >
                        {r.actionLabel}
                      </button>
                    )}
                    {r.href && (
                      <a
                        href={r.href}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] hover:bg-muted"
                      >
                        Learn more <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </div>
                )}
              </div>
              <button
                onClick={() => dismiss(r.id)}
                aria-label="Dismiss"
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
