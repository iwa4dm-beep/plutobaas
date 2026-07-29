// Verification run history for one import job: every archived smoke-test run
// plus the diff against the previous run (which table/check changed).
import { useCallback, useEffect, useState } from "react";
import { GitCompare, ShieldCheck } from "lucide-react";
import {
  compareVerificationRunsFn,
  listVerificationRunsFn,
  type VerificationRunView,
} from "@/lib/pluto/import-job.functions";
import { describeDiff, type VerificationDiff } from "@/lib/pluto/verification-diff";

export function VerificationRunsCard({ jobId, refreshKey }: { jobId: string; refreshKey?: number }) {
  const [runs, setRuns] = useState<VerificationRunView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [from, setFrom] = useState<number | "">("");
  const [to, setTo] = useState<number | "">("");
  const [diff, setDiff] = useState<VerificationDiff | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listVerificationRunsFn({ data: { id: jobId } });
      if (!r.ok) setErr(r.error);
      else {
        setErr(null);
        setRuns(r.runs);
        if (r.runs.length >= 2) { setTo(r.runs[0].run_no); setFrom(r.runs[1].run_no); }
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }, [jobId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  async function compare() {
    if (from === "" || to === "") return;
    setLoading(true);
    try {
      const r = await compareVerificationRunsFn({ data: { id: jobId, from: Number(from), to: Number(to) } });
      if (!r.ok || !r.diff) setErr(r.error ?? "Compare failed");
      else { setErr(null); setDiff(r.diff); }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setLoading(false); }
  }

  if (!runs.length && !err) return null;

  return (
    <div className="border rounded p-2 bg-background">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium inline-flex items-center gap-1">
          <ShieldCheck className="h-3.5 w-3.5" /> Verification runs
          <span className="font-normal text-muted-foreground"> · {runs.length} archived</span>
        </div>
        {runs.length >= 2 && (
          <div className="flex items-center gap-1 text-[11px]">
            <select value={from} onChange={(e) => setFrom(Number(e.target.value))} className="rounded border bg-background px-1 py-0.5">
              {runs.map((r) => <option key={r.run_no} value={r.run_no}>#{r.run_no}</option>)}
            </select>
            <span className="text-muted-foreground">→</span>
            <select value={to} onChange={(e) => setTo(Number(e.target.value))} className="rounded border bg-background px-1 py-0.5">
              {runs.map((r) => <option key={r.run_no} value={r.run_no}>#{r.run_no}</option>)}
            </select>
            <button className="underline inline-flex items-center gap-1" disabled={loading} onClick={() => void compare()}>
              <GitCompare className="h-3 w-3" /> Compare
            </button>
          </div>
        )}
      </div>

      {err && <p className="mt-1 text-[11px] text-destructive">{err}</p>}

      <div className="mt-2 max-h-40 overflow-auto border rounded text-[11px]">
        {runs.map((r) => (
          <div key={r.run_no} className="flex gap-2 px-2 py-0.5 border-t first:border-t-0">
            <span className="font-mono">#{r.run_no}</span>
            <span className={r.ok ? "text-primary" : "text-destructive"}>{r.ok ? "pass" : "fail"}</span>
            <span className="text-muted-foreground">{r.trigger}</span>
            <span className="text-muted-foreground truncate">{r.actor_email ?? "system"}</span>
            <span className="ml-auto text-muted-foreground whitespace-nowrap">{new Date(r.created_at).toLocaleString()}</span>
          </div>
        ))}
      </div>

      {diff && (
        <div className="mt-2 border rounded p-2 text-[11px]">
          <div className="font-medium">Run #{diff.fromRun} → #{diff.toRun}: {describeDiff(diff)}</div>
          {diff.deltas.length ? (
            <div className="mt-1 max-h-40 overflow-auto">
              {diff.deltas.map((d) => (
                <div key={`${d.kind}:${d.id}`} className="flex gap-2 border-t py-0.5 first:border-t-0">
                  <span className={d.kind === "removed" ? "text-destructive" : d.kind === "added" ? "text-primary" : "text-amber-600"}>{d.kind}</span>
                  <span className="font-mono truncate max-w-[12rem]">{d.target}</span>
                  <span className="text-muted-foreground truncate">{d.label}</span>
                  <span className="ml-auto text-muted-foreground whitespace-nowrap">
                    {d.from ?? "—"} → {d.to ?? "—"}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground">No differences between these runs.</p>
          )}
        </div>
      )}
    </div>
  );
}
