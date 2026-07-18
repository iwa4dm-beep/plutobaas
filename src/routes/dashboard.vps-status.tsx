import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { checkVpsHealth } from "@/lib/pluto/vps-health.functions";
import { CheckCircle2, XCircle, RefreshCw, KeyRound } from "lucide-react";
import { WorkspaceProvisionCard } from "@/components/pluto/WorkspaceProvisionCard";

export const Route = createFileRoute("/dashboard/vps-status")({
  component: VpsStatusPage,
  head: () => ({
    meta: [
      { title: "VPS Status — Pluto Admin" },
      { name: "description", content: "Live health of the Pluto VPS backend (api.timescard.cloud)." },
    ],
  }),
});

function VpsStatusPage() {
  const router = useRouter();
  const { data, isLoading, refetch, isFetching, error } = useQuery({
    queryKey: ["vps-health"],
    queryFn: () => checkVpsHealth(),
    refetchInterval: 30_000,
  });

  return (
    <div className="p-6 space-y-6 max-w-4xl">
      <PageHeader
        title="VPS Status"
        description="Live health of the Pluto backend running on the VPS."
        actions={
          <button
            onClick={() => { refetch(); router.invalidate(); }}
            disabled={isFetching}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      />

      {isLoading && <div className="text-sm text-muted-foreground">Probing VPS…</div>}
      <ErrorBanner error={error} onRetry={() => refetch()} />


      {data && (
        <>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              {data.healthy
                ? <CheckCircle2 className="h-6 w-6 text-emerald-500" />
                : <XCircle className="h-6 w-6 text-destructive" />}
              <div>
                <div className="font-medium">{data.healthy ? "All systems operational" : "Degraded"}</div>
                <div className="text-xs text-muted-foreground font-mono">{data.baseUrl}</div>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card p-4 flex items-center gap-3">
            <KeyRound className={`h-5 w-5 ${data.serviceKeyConfigured ? "text-emerald-500" : "text-amber-500"}`} />
            <div className="text-sm">
              <div className="font-medium">
                Service-role key {data.serviceKeyConfigured ? "configured" : "missing"}
              </div>
              <div className="text-xs text-muted-foreground">
                {data.serviceKeyConfigured
                  ? "Auto-Connect can deploy migrations & provision workspaces automatically."
                  : "Add PLUTO_SERVICE_ROLE_KEY in project secrets to enable auto-deploy & workspace provisioning."}
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium">Endpoint</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Latency</th>
                  <th className="px-4 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.probes.map((p) => (
                  <tr key={p.path} className="border-t border-border">
                    <td className="px-4 py-2 font-mono text-xs">{p.path}</td>
                    <td className="px-4 py-2">
                      <span className={p.ok
                        ? "inline-flex items-center gap-1 text-emerald-600"
                        : "inline-flex items-center gap-1 text-destructive"}>
                        {p.ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                        {p.status || "ERR"}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{p.latencyMs} ms</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground truncate max-w-xs">
                      {p.error ?? p.body ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-muted-foreground">
            Last checked: {new Date(data.checkedAt).toLocaleString()} • auto-refresh every 30s
          </div>

          <WorkspaceProvisionCard />
        </>
      )}
    </div>
  );
}
