import type { DeployAllResult, SslProbe, LiveUrlProbe } from "@/lib/pluto/vps-deployer.functions";
import { CheckCircle2, AlertTriangle, XCircle, Clock, ExternalLink, ShieldCheck } from "lucide-react";

type CheckStatus = "pass" | "warn" | "fail" | "skip";

interface CheckRow {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

function statusIcon(s: CheckStatus) {
  if (s === "pass") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (s === "warn") return <AlertTriangle className="h-4 w-4 text-amber-500" />;
  if (s === "fail") return <XCircle className="h-4 w-4 text-destructive" />;
  return <Clock className="h-4 w-4 text-muted-foreground" />;
}

function stepDetail(step: DeployAllResult["steps"][number] | undefined, fallback = "not run") {
  if (!step) return fallback;
  const last = step.attempts[step.attempts.length - 1];
  return last?.detail || (typeof step.result === "string" && step.result ? step.result : fallback);
}

function computeChecks(result: DeployAllResult): CheckRow[] {
  const rows: CheckRow[] = [];
  const stepBy = Object.fromEntries(result.steps.map((s) => [s.key, s] as const));
  const ssl = (result.liveUrls as { sslProbe?: SslProbe } | undefined)?.sslProbe;
  const servedProbe = (result.liveUrls as { servedSiteProbe?: LiveUrlProbe } | undefined)?.servedSiteProbe;

  // Migrations
  const mig = stepBy["push-migrations"];
  rows.push({
    id: "migrations",
    label: "Database migrations applied",
    status: !mig ? "skip" : mig.ok ? "pass" : "fail",
    detail: stepDetail(mig),
  });

  // Bundle unpack
  const unpack = stepBy["unpack-serve"];
  rows.push({
    id: "unpack",
    label: "Bundle unpacked on worker",
    status: !unpack ? "skip" : unpack.ok ? "pass" : "fail",
    detail: stepDetail(unpack),
  });

  // Health
  const health = stepBy["health-check"];
  rows.push({
    id: "health",
    label: "Health probes reachable",
    status: !health ? "skip" : health.ok ? "pass" : "warn",
    detail: stepDetail(health),
  });

  // Served site
  const servedRouteMismatch = servedProbe?.httpOk === true && servedProbe.reachable === false;
  rows.push({
    id: "served-site",
    label: "Served site routes deployed app",
    status: !servedProbe ? "skip" : servedProbe.reachable ? "pass" : "warn",
    detail: servedProbe
      ? `HTTP ${servedProbe.status} · ${servedProbe.latencyMs}ms · ${servedRouteMismatch ? `route mismatch: ${servedProbe.routeMismatchReason ?? "wrong app"} · ` : ""}${servedProbe.url}`
      : "no served-site URL resolved",
  });

  // SSL valid
  rows.push({
    id: "ssl-valid",
    label: "SSL/HTTPS certificate valid",
    status: !ssl ? "skip" : ssl.ok ? "pass" : "fail",
    detail: ssl
      ? `${ssl.cert?.issuer ?? "unknown issuer"} · HTTPS ${ssl.httpsStatus || "err"}${ssl.error ? " · " + ssl.error : ""}`
      : "not evaluated (no https target)",
  });

  // SSL expiry
  const days = ssl?.cert?.daysUntilExpiry ?? null;
  rows.push({
    id: "ssl-expiry",
    label: "SSL certificate has >30 days remaining",
    status: days == null ? "skip" : days > 30 ? "pass" : days > 7 ? "warn" : "fail",
    detail: days == null ? "unknown" : `${days} days until expiry`,
  });

  // Hostname match
  if (ssl?.cert?.hostnameMatch != null) {
    rows.push({
      id: "ssl-hostname",
      label: "SSL hostname matches served site",
      status: ssl.cert.hostnameMatch ? "pass" : "fail",
      detail: ssl.cert.hostnameMatch ? "match" : "MISMATCH — wildcard cert missing for this slug",
    });
  }

  return rows;
}

export function DeploySummaryChecksPanel({ result }: { result: DeployAllResult }) {
  const okCount = result.steps.filter((s) => s.ok).length;
  const failCount = result.steps.filter((s) => !s.ok).length;
  const checks = computeChecks(result);
  const passing = checks.filter((c) => c.status === "pass").length;
  const warning = checks.filter((c) => c.status === "warn").length;
  const failing = checks.filter((c) => c.status === "fail").length;
  const ssl = (result.liveUrls as { sslProbe?: SslProbe } | undefined)?.sslProbe;
  const resolvedSite =
    (result.liveUrls as { resolvedSite?: string; servedSite?: string } | undefined)?.resolvedSite ??
    (result.liveUrls as { servedSite?: string } | undefined)?.servedSite ??
    null;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-medium flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" /> Deployment summary
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4 text-xs">
        <SummaryCell label="Status" value={result.ok ? "Success" : "Failed"} tone={result.ok ? "pass" : "fail"} />
        <SummaryCell label="Total time" value={`${(result.totalMs / 1000).toFixed(1)}s`} />
        <SummaryCell label="Steps" value={`${okCount} ok · ${failCount} failed`} />
        <SummaryCell label="Checks" value={`${passing} pass · ${warning} warn · ${failing} fail`} />
        <SummaryCell label="Workspace" value={result.workspaceId?.slice(0, 8) ?? "—"} mono />
        <SummaryCell
          label="SSL issuer"
          value={ssl?.cert?.issuer ?? "—"}
        />
        <SummaryCell
          label="SSL expiry"
          value={ssl?.cert?.daysUntilExpiry != null ? `${ssl.cert.daysUntilExpiry}d` : "—"}
          tone={ssl?.cert?.daysUntilExpiry != null ? (ssl.cert.daysUntilExpiry > 30 ? "pass" : ssl.cert.daysUntilExpiry > 7 ? "warn" : "fail") : undefined}
        />
        <SummaryCell
          label="Served site"
          value={resolvedSite ? new URL(resolvedSite).host : "—"}
          link={resolvedSite ?? undefined}
        />
      </div>
      <div className="border-t border-border">
        <div className="px-4 py-2 text-xs font-medium text-muted-foreground">Deployment checks</div>
        <ul className="divide-y divide-border">
          {checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 px-4 py-2.5 text-xs">
              <span className="mt-0.5">{statusIcon(c.status)}</span>
              <div className="flex-1 min-w-0">
                <div className="font-medium">{c.label}</div>
                <div className="text-muted-foreground truncate">{c.detail}</div>
              </div>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{c.status}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SummaryCell({
  label,
  value,
  tone,
  mono,
  link,
}: {
  label: string;
  value: string;
  tone?: "pass" | "warn" | "fail";
  mono?: boolean;
  link?: string;
}) {
  const toneCls =
    tone === "pass"
      ? "text-emerald-600"
      : tone === "warn"
      ? "text-amber-600"
      : tone === "fail"
      ? "text-destructive"
      : "";
  return (
    <div className="rounded-md border border-border/60 bg-muted/30 px-2.5 py-2">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`mt-0.5 truncate ${mono ? "font-mono" : ""} ${toneCls}`}>
        {link ? (
          <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
            {value} <ExternalLink className="h-3 w-3" />
          </a>
        ) : (
          value
        )}
      </div>
    </div>
  );
}
