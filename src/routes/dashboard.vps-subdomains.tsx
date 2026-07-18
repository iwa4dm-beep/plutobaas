import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ExternalLink, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { useServerAction } from "@/lib/pluto/use-server-action";
import { getActiveSubdomains, type ActiveSubdomain } from "@/lib/pluto/vps-health.functions";
import { runVpsRepair } from "@/lib/pluto/vps-repair.functions";

export const Route = createFileRoute("/dashboard/vps-subdomains")({
  component: VpsSubdomainsPage,
  head: () => ({
    meta: [
      { title: "VPS Subdomains — Pluto Admin" },
      { name: "description", content: "Active VPS subdomains with nginx routing and SSL validity checks." },
    ],
  }),
});

function VpsSubdomainsPage() {
  const router = useRouter();
  const [repairingHost, setRepairingHost] = useState("");
  const { data, isLoading, isFetching, refetch, error: queryError } = useQuery({
    queryKey: ["vps-active-subdomains"],
    queryFn: () => getActiveSubdomains({ data: { baseDomain: "app.timescard.cloud" } }),
    refetchInterval: 60_000,
  });

  const repair = useServerAction(runVpsRepair, {
    successMessage: "Repair completed",
    errorTitle: "Repair failed",
    onSuccess: () => { refetch(); },
  });

  const expiring = data?.subdomains.filter((d) => d.ssl.daysLeft != null && d.ssl.daysLeft <= 30) ?? [];

  const fixSubdomain = async (row: ActiveSubdomain) => {
    setRepairingHost(row.host);
    try {
      const action = row.issues.includes("ssl_invalid") || row.issues.includes("ssl_expiring_soon") ? "all" : "worker-and-site";
      await repair.run({ data: { action, slug: row.slug, wildcard: data?.baseDomain || "app.timescard.cloud" } });
    } finally {
      setRepairingHost("");
    }
  };

  return (
    <div className="max-w-7xl space-y-6 p-6">
      <PageHeader
        title="VPS Subdomains"
        description="Currently active subdomains, nginx enable status, served-site readiness, and SSL validity."
        actions={
          <button
            type="button"
            onClick={() => { refetch(); router.invalidate(); }}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Checking VPS subdomains…</div>}

      <ErrorBanner error={queryError} onRetry={() => refetch()} />
      <ErrorBanner error={repair.error} onDismiss={repair.reset} />

      {data?.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <div className="font-medium">Subdomain API unavailable</div>
          <div className="mt-1 text-destructive/80">{data.hint ?? data.error}</div>
        </div>
      )}


      {data && (
        <>
          <div className="grid gap-3 md:grid-cols-5">
            <SummaryCard label="Total" value={data.summary.ready + data.summary.broken} />
            <SummaryCard label="Ready" value={data.summary.ready} tone="ok" />
            <SummaryCard label="Nginx enabled" value={data.summary.nginxEnabled} />
            <SummaryCard label="SSL valid" value={data.summary.sslValid} tone="ok" />
            <SummaryCard label="SSL ≤30d" value={data.summary.expiringSoon} tone={data.summary.expiringSoon ? "warn" : "ok"} />
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="mb-3 flex items-center gap-2">
              {expiring.length ? <AlertTriangle className="h-5 w-5 text-warning" /> : <ShieldCheck className="h-5 w-5 text-success" />}
              <div>
                <div className="font-medium">SSL pre-check</div>
                <div className="text-xs text-muted-foreground">Certificates expiring within 30 days are flagged before go-live.</div>
              </div>
            </div>
            {expiring.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground">
                    <tr><th className="py-2">Host</th><th className="py-2">CN</th><th className="py-2">Expires</th><th className="py-2">Days left</th></tr>
                  </thead>
                  <tbody>
                    {expiring.map((row) => (
                      <tr key={row.host} className="border-t border-border">
                        <td className="py-2 font-mono text-xs">{row.host}</td>
                        <td className="py-2">{row.ssl.cn ?? "—"}</td>
                        <td className="py-2">{row.ssl.expiry ?? "—"}</td>
                        <td className="py-2 text-warning">{row.ssl.daysLeft ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No certificate is expiring within the next 30 days.</div>
            )}
          </div>

          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Subdomain</th>
                    <th className="px-4 py-3 font-medium">Nginx</th>
                    <th className="px-4 py-3 font-medium">Worker</th>
                    <th className="px-4 py-3 font-medium">HTTPS</th>
                    <th className="px-4 py-3 font-medium">SSL</th>
                    <th className="px-4 py-3 font-medium">Issues</th>
                    <th className="px-4 py-3 font-medium">Fix</th>
                  </tr>
                </thead>
                <tbody>
                  {data.subdomains.map((row) => <SubdomainRow key={row.host} row={row} onFix={fixSubdomain} fixing={repairingHost === row.host} />)}
                  {!data.subdomains.length && (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No active subdomains found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="text-xs text-muted-foreground">
            JSON API: <span className="font-mono">/api/public/vps-subdomains?baseDomain={data.baseDomain}</span> · Bearer service token required · Last checked {new Date(data.checkedAt).toLocaleString()}
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone?: "ok" | "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : ""}`}>{value}</div>
    </div>
  );
}

function SubdomainRow({ row, onFix, fixing }: { row: ActiveSubdomain; onFix: (row: ActiveSubdomain) => void; fixing: boolean }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="px-4 py-3">
        <a href={row.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 font-mono text-xs text-primary hover:underline">
          {row.host}<ExternalLink className="h-3 w-3" />
        </a>
        <div className="mt-1 text-xs text-muted-foreground">slug: {row.slug}</div>
      </td>
      <td className="px-4 py-3"><BoolBadge ok={row.nginx.enabled} label={row.nginx.enabled ? "enabled" : "missing"} /></td>
      <td className="px-4 py-3">
        <BoolBadge ok={row.worker.ready} label={row.worker.ready ? row.worker.channel ?? "ready" : row.worker.error ?? "not ready"} />
        {row.worker.servedAt && <div className="mt-1 text-xs text-muted-foreground">{new Date(row.worker.servedAt).toLocaleString()}</div>}
      </td>
      <td className="px-4 py-3"><BoolBadge ok={row.https.status >= 200 && row.https.status < 500} label={row.https.status ? `HTTP ${row.https.status}` : row.https.error ?? "ERR"} /></td>
      <td className="px-4 py-3">
        <BoolBadge ok={row.ssl.valid} label={row.ssl.valid ? `${row.ssl.daysLeft ?? "?"}d left` : row.ssl.warning ?? "invalid"} warn={row.ssl.daysLeft != null && row.ssl.daysLeft <= 30} />
        <div className="mt-1 text-xs text-muted-foreground">{row.ssl.cn ?? "—"}</div>
      </td>
      <td className="px-4 py-3 text-xs text-muted-foreground">{row.issues.length ? row.issues.join(", ") : "—"}</td>
      <td className="px-4 py-3">
        <button
          type="button"
          onClick={() => onFix(row)}
          disabled={row.ok || fixing}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${fixing ? "animate-spin" : ""}`} />
          Fix
        </button>
      </td>
    </tr>
  );
}

function BoolBadge({ ok, warn, label }: { ok: boolean; warn?: boolean; label: string }) {
  const cls = ok
    ? warn ? "border-warning/30 bg-warning/10 text-warning" : "border-success/30 bg-success/10 text-success"
    : "border-destructive/30 bg-destructive/10 text-destructive";
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${cls}`}>
      {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  );
}