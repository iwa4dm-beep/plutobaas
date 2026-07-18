import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, RefreshCw, RotateCw, ShieldAlert, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";
import { useServerAction } from "@/lib/pluto/use-server-action";
import {
  getRepairHistory,
  getSlugSecretStatus,
  provisionSubdomain,
  rotateSlugSecret,
  revokeSlugSecret,
  type WorkerJson,
} from "@/lib/pluto/slug-secrets.functions";
import { runVpsRepair } from "@/lib/pluto/vps-repair.functions";

export const Route = createFileRoute("/dashboard/vps-recovery")({
  component: VpsRecoveryPage,
  head: () => ({
    meta: [
      { title: "VPS Recovery — Pluto Admin" },
      { name: "description", content: "Auto-recover status for wildcard mapping and SSL, plus per-subdomain secret rotation." },
    ],
  }),
});

type HistoryEntry = {
  action?: string; slug?: string | null; wildcard?: string | null;
  ok?: boolean; exitCode?: number; startedAt?: string; finishedAt?: string;
  durationMs?: number; tail?: string; hint?: string | null;
};

function fmtDuration(ms?: number) {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtWhen(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function VpsRecoveryPage() {
  const [slug, setSlug] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const history = useQuery({
    queryKey: ["vps-repair-history"],
    queryFn: () => getRepairHistory({ data: { limit: 25 } }),
    refetchInterval: 30_000,
  });

  const status = useQuery({
    queryKey: ["slug-secret-status", slug],
    queryFn: () => getSlugSecretStatus({ data: { slug } }),
    enabled: !!slug && /^[a-z0-9-]+$/i.test(slug),
  });

  const refetchAll = () => { history.refetch(); status.refetch(); };

  const rotate = useServerAction(rotateSlugSecret, {
    successMessage: "Secret rotated",
    errorTitle: "Rotate failed",
    onSuccess: (r) => {
      const secret = (r as WorkerJson | undefined)?.secret;
      if (secret) setRevealed(String(secret));
      refetchAll();
    },
  });
  const revoke = useServerAction(revokeSlugSecret, {
    successMessage: "Secret revoked",
    errorTitle: "Revoke failed",
    onSuccess: refetchAll,
  });
  const provision = useServerAction(provisionSubdomain, {
    successMessage: "Subdomain provisioned + secret rotated",
    errorTitle: "Provision failed",
    onSuccess: (r) => {
      const inner = (r as WorkerJson | undefined)?.secret as WorkerJson | undefined;
      if (inner?.secret) setRevealed(String(inner.secret));
      refetchAll();
    },
  });
  const repair = useServerAction(runVpsRepair, {
    successMessage: "Repair triggered",
    errorTitle: "Repair failed",
    onSuccess: refetchAll,
  });

  const busy = rotate.isPending || revoke.isPending || provision.isPending || repair.isPending;

  const entries = useMemo<HistoryEntry[]>(() => {
    const raw = history.data as WorkerJson | undefined;
    if (!raw || !Array.isArray(raw.entries)) return [];
    return raw.entries as HistoryEntry[];
  }, [history.data]);

  const lastByAction = useMemo(() => {
    const m = new Map<string, HistoryEntry>();
    for (const e of entries) if (e.action && !m.has(e.action)) m.set(e.action, e);
    return m;
  }, [entries]);



  return (
    <div className="space-y-6 p-6">
      <PageHeader
        title="VPS Recovery"
        description="Wildcard mapping / SSL auto-recovery status, repair history, and per-subdomain secret rotation."
      />

      {/* Wildcard/SSL status via last repair actions */}
      <section className="grid gap-3 md:grid-cols-3">
        {(["wildcard-ssl", "worker-and-site", "deploy-and-verify"] as const).map((action) => {
          const e = lastByAction.get(action);
          const ok = e?.ok === true;
          return (
            <div key={action} className="rounded-lg border border-border/60 bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium text-muted-foreground">{action}</div>
                {e ? (ok ? <CheckCircle2 className="h-5 w-5 text-emerald-500" /> : <XCircle className="h-5 w-5 text-destructive" />) : <ShieldAlert className="h-5 w-5 text-muted-foreground" />}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">Last run: {fmtWhen(e?.finishedAt || e?.startedAt)}</div>
              <div className="text-xs text-muted-foreground">Result: {e ? (ok ? "success" : `exit ${e.exitCode ?? "?"}`) : "no runs yet"}</div>
              {e?.hint ? <div className="mt-2 text-xs text-amber-500">{e.hint}</div> : null}
              <button
                type="button"
                disabled={busy === `run-${action}`}
                onClick={() => withBusy(
                  `run-${action}`,
                  () => repair({ data: { action, slug: slug || undefined } }),
                  `Triggered ${action}`
                )}
                className="mt-3 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                <RotateCw className="h-3 w-3" /> Run now
              </button>
            </div>
          );
        })}
      </section>

      {/* Slug picker + secret controls */}
      <section className="rounded-lg border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Slug</span>
            <input
              value={slug}
              onChange={(e) => { setSlug(e.target.value.toLowerCase().trim()); setRevealed(null); }}
              placeholder="e.g. frfrom-he3wm0"
              className="w-72 rounded-md border border-border/60 bg-background px-2 py-1 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            disabled={!slug || busy === "provision"}
            onClick={() => withBusy(
              "provision",
              async () => {
                const r = await provision({ data: { slug, seed: true, rotateSecret: true, revealSecret: true } }) as WorkerJson;
                if (r?.secret && (r.secret as WorkerJson).secret) setRevealed(String((r.secret as WorkerJson).secret));
                return r;
              },
              "Subdomain provisioned + secret rotated"
            )}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Provision + rotate
          </button>
          <button
            type="button"
            disabled={!slug || busy === "rotate"}
            onClick={() => withBusy(
              "rotate",
              async () => {
                const r = await rotate({ data: { slug } }) as WorkerJson;
                if (r?.secret) setRevealed(String(r.secret));
                return r;
              },
              "Secret rotated"
            )}
            className="rounded-md border border-border/60 bg-background px-3 py-1.5 text-sm hover:bg-muted disabled:opacity-50"
          >
            Rotate secret
          </button>
          <button
            type="button"
            disabled={!slug || busy === "revoke"}
            onClick={() => withBusy("revoke", () => revoke({ data: { slug } }), "Secret revoked")}
            className="rounded-md border border-destructive/40 bg-background px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
          >
            Revoke
          </button>
          <button
            type="button"
            onClick={() => { history.refetch(); status.refetch(); }}
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>

        {slug && status.data ? (
          <div className="mt-3 grid gap-2 text-xs md:grid-cols-2">
            <div>Has secret: <span className="font-mono">{String((status.data as WorkerJson).hasSecret ?? false)}</span></div>
            <div>Rotation count: <span className="font-mono">{String((status.data as WorkerJson).rotationCount ?? 0)}</span></div>
            <div>Rotated at: <span className="font-mono">{fmtWhen(String((status.data as WorkerJson).rotatedAt || ""))}</span></div>
            <div>Fingerprint: <span className="font-mono">{String((status.data as WorkerJson).fingerprint || "—")}</span></div>
            <div className="md:col-span-2">Secret ref: <span className="font-mono">{String((status.data as WorkerJson).secretRef || "—")}</span></div>
          </div>
        ) : null}

        {revealed ? (
          <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <div className="mb-1 font-medium text-amber-500">Copy this secret now — it will not be shown again:</div>
            <code className="break-all font-mono">{revealed}</code>
          </div>
        ) : null}
      </section>

      {/* Repair history */}
      <section className="rounded-lg border border-border/60 bg-card">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
          <h2 className="text-sm font-medium">Recent repair runs</h2>
          <span className="text-xs text-muted-foreground">{entries.length} entries · auto-refresh 30s</span>
        </div>
        {history.isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="p-4 text-sm text-muted-foreground">No repair runs recorded yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-left">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Action</th>
                  <th className="px-3 py-2">Slug</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Hint / tail</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={i} className="border-t border-border/40 align-top">
                    <td className="px-3 py-2 font-mono">{fmtWhen(e.finishedAt || e.startedAt)}</td>
                    <td className="px-3 py-2">{e.action || "—"}</td>
                    <td className="px-3 py-2 font-mono">{e.slug || "—"}</td>
                    <td className={`px-3 py-2 ${e.ok ? "text-emerald-500" : "text-destructive"}`}>{e.ok ? "success" : `fail (${e.exitCode ?? "?"})`}</td>
                    <td className="px-3 py-2">{fmtDuration(e.durationMs)}</td>
                    <td className="px-3 py-2">
                      {e.hint ? <div className="text-amber-500">{e.hint}</div> : null}
                      {e.tail ? <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap break-all text-[10px] text-muted-foreground">{e.tail.slice(-400)}</pre> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
