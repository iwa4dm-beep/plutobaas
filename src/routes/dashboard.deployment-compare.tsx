import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftRight, CheckCircle2, XCircle, Circle, GitCompare } from "lucide-react";
import { loadHistory, compareEntries, type HistoryEntry } from "@/lib/pluto/deploy-history";

export const Route = createFileRoute("/dashboard/deployment-compare")({
  head: () => ({
    meta: [
      { title: "Compare Deployments — Pluto BaaS" },
      { name: "description", content: "Diff two VPS deployment attempts side by side." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DeploymentComparePage,
});

function fmt(ts: number) { return new Date(ts).toLocaleString(); }
function label(e: HistoryEntry) { return `${fmt(e.timestamp)} · ${e.workspaceId} · ${e.overallOk ? "OK" : "FAIL"}`; }

function StepIcon({ state }: { state?: string }) {
  if (state === "ok") return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  if (state === "error") return <XCircle className="h-4 w-4 text-destructive" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

function DeploymentComparePage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [leftId, setLeftId] = useState<string>("");
  const [rightId, setRightId] = useState<string>("");

  useEffect(() => {
    const refresh = () => {
      const all = loadHistory();
      setEntries(all);
      if (all.length >= 2) {
        setLeftId((v) => v || all[1].id);
        setRightId((v) => v || all[0].id);
      }
    };
    refresh();
    window.addEventListener("pluto:deploy-history:changed", refresh);
    return () => window.removeEventListener("pluto:deploy-history:changed", refresh);
  }, []);

  const left = useMemo(() => entries.find(e => e.id === leftId) ?? null, [entries, leftId]);
  const right = useMemo(() => entries.find(e => e.id === rightId) ?? null, [entries, rightId]);
  const diff = useMemo(() => (left && right ? compareEntries(left, right) : null), [left, right]);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <GitCompare className="h-7 w-7" /> Compare Deployments
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            দুটি deployment attempt পাশে-পাশে diff — state, HTTP status, latency, request/response body change হাইলাইট হবে।
          </p>
        </header>

        {entries.length < 2 && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            Compare করতে অন্তত ২টা deploy attempt দরকার। Auto-Connect Studio থেকে চালিয়ে আসুন।
          </div>
        )}

        {entries.length >= 2 && (
          <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              <SelectPanel title="Left (baseline)" entries={entries} value={leftId} onChange={setLeftId} />
              <SelectPanel title="Right (new)" entries={entries} value={rightId} onChange={setRightId} />
            </div>

            {diff && left && right && (
              <div className="space-y-4">
                <div className="rounded-lg border border-border bg-card p-4 flex flex-wrap items-center gap-3 text-sm">
                  <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
                  <span>Workspace: {diff.workspaceChanged ? <b className="text-amber-600">changed ({left.workspaceId} → {right.workspaceId})</b> : <span className="font-mono">{left.workspaceId}</span>}</span>
                  <span>·</span>
                  <span>Overall: {diff.overallChanged ? <b className="text-amber-600">changed ({left.overallOk ? "OK" : "FAIL"} → {right.overallOk ? "OK" : "FAIL"})</b> : (left.overallOk ? "OK on both" : "FAIL on both")}</span>
                </div>

                {diff.steps.map((s) => (
                  <div key={s.key} className="rounded-lg border border-border bg-card">
                    <div className="p-3 border-b border-border flex items-center gap-3">
                      <span className="font-semibold text-sm">{s.label}</span>
                      {s.stateChanged && <Badge tone="amber">state changed</Badge>}
                      {s.statusChanged && <Badge tone="amber">HTTP status changed</Badge>}
                      {s.reqBodyChanged && <Badge tone="amber">request body changed</Badge>}
                      {s.resBodyChanged && <Badge tone="amber">response body changed</Badge>}
                      {s.latencyDeltaMs !== null && s.latencyDeltaMs !== 0 && (
                        <Badge tone={Math.abs(s.latencyDeltaMs) > 500 ? "amber" : "muted"}>
                          latency Δ {s.latencyDeltaMs > 0 ? "+" : ""}{s.latencyDeltaMs}ms
                        </Badge>
                      )}
                      {!s.stateChanged && !s.statusChanged && !s.reqBodyChanged && !s.resBodyChanged && (
                        <Badge tone="emerald">identical</Badge>
                      )}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border text-xs font-mono">
                      <StepSide side={s.left} highlight={s.stateChanged || s.statusChanged || s.reqBodyChanged || s.resBodyChanged} />
                      <StepSide side={s.right} highlight={s.stateChanged || s.statusChanged || s.reqBodyChanged || s.resBodyChanged} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SelectPanel({ title, entries, value, onChange }: {
  title: string; entries: HistoryEntry[]; value: string; onChange: (v: string) => void;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <label className="text-xs font-medium block mb-1.5">{title}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
      >
        <option value="">— select deployment —</option>
        {entries.map((e) => (
          <option key={e.id} value={e.id}>{label(e)}</option>
        ))}
      </select>
    </div>
  );
}

function StepSide({ side, highlight }: { side: import("@/lib/pluto/deploy-history").HistoryStep | null; highlight: boolean }) {
  if (!side) return <div className="p-3 text-muted-foreground italic">(no step data)</div>;
  return (
    <div className={`p-3 space-y-1.5 ${highlight ? "bg-amber-500/5" : ""}`}>
      <div className="flex items-center gap-2 not-mono text-sm font-sans">
        <StepIcon state={side.state} />
        <span className="font-medium">{side.state}</span>
        {side.debug && <span className="text-muted-foreground">HTTP {side.debug.status} · {side.debug.latencyMs}ms</span>}
      </div>
      {side.detail && <div className="text-muted-foreground break-all">{side.detail}</div>}
      {side.debug && (
        <>
          <div className="text-muted-foreground break-all">{side.debug.method} {side.debug.url}</div>
          {side.debug.reqBodyPreview && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">Request</summary>
              <pre className="whitespace-pre-wrap break-all mt-1 bg-background/60 p-2 rounded">{side.debug.reqBodyPreview}</pre>
            </details>
          )}
          <details>
            <summary className="cursor-pointer text-muted-foreground">Response</summary>
            <pre className="whitespace-pre-wrap break-all mt-1 bg-background/60 p-2 rounded">{side.debug.resBodyPreview}</pre>
          </details>
        </>
      )}
    </div>
  );
}

function Badge({ tone, children }: { tone: "amber" | "emerald" | "muted"; children: React.ReactNode }) {
  const cls = tone === "amber"
    ? "bg-amber-500/10 text-amber-700 border-amber-500/30"
    : tone === "emerald"
      ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30"
      : "bg-muted text-muted-foreground border-border";
  return <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{children}</span>;
}
