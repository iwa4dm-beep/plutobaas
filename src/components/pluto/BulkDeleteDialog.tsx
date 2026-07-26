// Shared bulk-delete confirmation dialog with per-item status streaming.
// Uses the delete-store scheduler so long / flaky VPS purges keep progressing
// after the dialog is closed; while open, we render live state via a
// subscription.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Loader2, RefreshCw, X, XCircle } from "lucide-react";
import { enqueueSoftDelete, retryJob, subscribe, type PurgeJob, getState } from "@/lib/pluto/delete-store";

export type BulkTarget = {
  id: string;
  label: string; // display name
  sublabel?: string; // slug / email etc.
  slug?: string; // projects only
  disabled?: boolean;
  disabledReason?: string;
};

export function BulkDeleteDialog({
  open, onClose, kind, targets, defaultAutoPurgeSlug = true, windowMinutes,
}: {
  open: boolean;
  onClose: () => void;
  kind: "project" | "user";
  targets: BulkTarget[];
  defaultAutoPurgeSlug?: boolean;
  /** Undo window in minutes. If 0, purge fires immediately. */
  windowMinutes: number;
}) {
  const [phase, setPhase] = useState<"confirm" | "running">("confirm");
  const [confirmText, setConfirmText] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set(targets.filter((t) => !t.disabled).map((t) => t.id)));
  const [autoPurge, setAutoPurge] = useState(defaultAutoPurgeSlug);
  const [jobIds, setJobIds] = useState<Record<string, string>>({});
  const [jobs, setJobs] = useState<PurgeJob[]>([]);

  // Reset when reopened.
  useEffect(() => {
    if (open) {
      setPhase("confirm");
      setConfirmText("");
      setChecked(new Set(targets.filter((t) => !t.disabled).map((t) => t.id)));
      setJobIds({});
    }
  }, [open, targets]);

  // Subscribe to store while running so per-item status updates live.
  useEffect(() => {
    if (phase !== "running") return;
    return subscribe((s) => setJobs(s.jobs));
  }, [phase]);

  const selectedTargets = useMemo(() => targets.filter((t) => checked.has(t.id)), [targets, checked]);
  const canRun = confirmText.trim().toUpperCase() === "DELETE" && selectedTargets.length > 0;

  function run(only?: BulkTarget[]) {
    const list = only ?? selectedTargets;
    const newIds: Record<string, string> = { ...jobIds };
    for (const t of list) {
      const { jobId } = enqueueSoftDelete({
        kind,
        targetId: t.id,
        label: t.label,
        slug: t.slug,
        autoPurgeSlug: autoPurge,
        windowMs: Math.max(0, windowMinutes) * 60_000,
      });
      newIds[t.id] = jobId;
    }
    setJobIds(newIds);
    setJobs(getState().jobs);
    setPhase("running");
  }

  if (!open) return null;

  const runningJobs = selectedTargets.map((t) => {
    const jobId = jobIds[t.id];
    const job = jobId ? jobs.find((j) => j.id === jobId) : undefined;
    return { t, job };
  });
  const allDone = phase === "running" && runningJobs.every((r) => r.job && (r.job.status === "ok" || r.job.status === "failed" || r.job.status === "cancelled"));
  const failed = runningJobs.filter((r) => r.job?.status === "failed").map((r) => r.t);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-2xl rounded-lg border bg-background shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {phase === "confirm"
              ? `Delete ${selectedTargets.length} ${kind}${selectedTargets.length === 1 ? "" : "s"}?`
              : `Deleting ${selectedTargets.length} ${kind}${selectedTargets.length === 1 ? "" : "s"}…`}
          </div>
          <button onClick={onClose} className="rounded-md p-1 hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[60vh] overflow-y-auto px-4 py-3 space-y-3">
          {phase === "confirm" && (
            <>
              <p className="text-sm text-muted-foreground">
                {windowMinutes > 0
                  ? <>Items will be moved to the recycle bin. If not restored within <strong>{windowMinutes} min</strong>, they will be permanently purged.</>
                  : <>Items will be permanently deleted immediately — no undo window.</>}
              </p>
              <ul className="divide-y rounded-md border">
                {targets.map((t) => (
                  <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <input
                      type="checkbox"
                      checked={checked.has(t.id)}
                      disabled={t.disabled}
                      onChange={(e) => {
                        setChecked((s) => {
                          const n = new Set(s);
                          if (e.target.checked) n.add(t.id); else n.delete(t.id);
                          return n;
                        });
                      }}
                    />
                    <span className={t.disabled ? "text-muted-foreground line-through" : ""}>{t.label}</span>
                    {t.sublabel && <span className="text-xs text-muted-foreground">({t.sublabel})</span>}
                    {t.disabled && t.disabledReason && (
                      <span className="ml-auto text-xs text-muted-foreground">{t.disabledReason}</span>
                    )}
                  </li>
                ))}
              </ul>

              {kind === "project" && (
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={autoPurge} onChange={(e) => setAutoPurge(e.target.checked)} />
                  Also purge each project's VPS site directory (/var/lib/pluto/sites/&lt;slug&gt;) when the window elapses
                </label>
              )}

              <label className="block text-xs">
                <span className="text-muted-foreground">Type <code className="font-mono font-semibold">DELETE</code> to confirm:</span>
                <input
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm"
                  placeholder="DELETE"
                  autoFocus
                />
              </label>
            </>
          )}

          {phase === "running" && (
            <ul className="divide-y rounded-md border">
              {runningJobs.map(({ t, job }) => (
                <li key={t.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                  <span className="mt-0.5">
                    {!job || job.status === "queued" ? <Circle className="h-4 w-4 text-muted-foreground" /> :
                     job.status === "running" ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> :
                     job.status === "ok" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> :
                     job.status === "cancelled" ? <Circle className="h-4 w-4 text-muted-foreground" /> :
                     <XCircle className="h-4 w-4 text-destructive" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.label}</span>
                      {t.sublabel && <span className="text-xs text-muted-foreground">({t.sublabel})</span>}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {job?.status === "queued" && windowMinutes > 0
                          ? `purge in ${Math.max(0, Math.ceil((new Date(job.runAfter).getTime() - Date.now()) / 60_000))}m`
                          : job?.status ?? "pending"}
                      </span>
                    </div>
                    {job?.dbError && <div className="mt-0.5 text-xs text-destructive break-all">DB: {job.dbError}</div>}
                    {job?.lastError && !job?.dbError && <div className="mt-0.5 text-xs text-destructive break-all">{job.lastError}</div>}
                    {job?.hint && <div className="mt-0.5 text-xs text-muted-foreground break-all">Hint: {job.hint}</div>}
                    {job?.removed?.length ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">Removed {job.removed.length} path{job.removed.length === 1 ? "" : "s"}.</div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t px-4 py-3">
          {phase === "confirm" ? (
            <>
              <button onClick={onClose} className="rounded-md border px-3 py-1.5 text-xs">Cancel</button>
              <button
                onClick={() => run()}
                disabled={!canRun}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs text-destructive-foreground disabled:opacity-50"
              >
                {windowMinutes > 0 ? `Move ${selectedTargets.length} to trash` : `Delete ${selectedTargets.length} permanently`}
              </button>
            </>
          ) : (
            <>
              {failed.length > 0 && (
                <button
                  onClick={() => {
                    for (const t of failed) {
                      const jobId = jobIds[t.id];
                      if (jobId) retryJob(jobId);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Retry {failed.length} failed
                </button>
              )}
              <button
                onClick={onClose}
                disabled={!allDone && windowMinutes === 0}
                className="rounded-md border px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {allDone ? "Close" : windowMinutes > 0 ? "Close (jobs will finish in background)" : "Working…"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
