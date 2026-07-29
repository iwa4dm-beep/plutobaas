// Pluto Migrator panel — lists signed import jobs sent by the Chrome
// extension and lets an admin select objects, review the SQL diff, dry-run
// and apply each migration. Every step is recorded in the import audit trail.
import { useCallback, useEffect,  useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Archive, CheckCircle2, ChevronDown, ChevronRight, Download, History, Pause, Play, RefreshCw, RotateCcw, ShieldCheck, Wand2, XCircle } from "lucide-react";
import {
  applyImportJob,
  dryRunImportJob,
  getSqlVersionFn,
  importAuditHistoryFn,
  importFailureDetailFn,
  importJobPlanFn,
  listImportJobsFn,
  listSqlVersionsFn,
  restoreSqlVersionFn,
  retranslateImportJob,
  retryImportJob,
  setImportJobPaused,
  type FailureStepView,
  type ImportEventView,
  type ImportJobView,
  type SqlOutcome,
  type SqlVersionView,
} from "@/lib/pluto/import-job.functions";
import { useImportEventStream, type LiveJobPatch } from "@/lib/pluto/use-import-stream";
import { buildImportReportFn, runVerificationFn, type ImportReportBundle } from "@/lib/pluto/import-job.functions";
import { downloadReportJson, openReportPdf } from "@/lib/pluto/import-report";
import type { SmokeReport } from "@/lib/pluto/smoke-types";
import { previewRollbackFn, runRollbackFn } from "@/lib/pluto/import-job.functions";
import type { RollbackPlan } from "@/lib/pluto/sql-rollback";
import type { DumpObject } from "@/lib/pluto/supabase-objects";
import type { SqlDiff } from "@/lib/pluto/sql-diff";
import { VerificationRunsCard } from "@/components/pluto/VerificationRunsCard";
import { ShareReportCard } from "@/components/pluto/ShareReportCard";
import { NotifyWebhookCard } from "@/components/pluto/NotifyWebhookCard";


const EXT_ZIP = "/downloads/pluto-migrator-extension.zip";

const STEPS = ["received", "translated", "dry_run", "apply"] as const;

function statusTone(s: string) {
  if (s === "applied" || s === "dry_run_ok") return "bg-primary/10 text-primary";
  if (s.endsWith("failed")) return "bg-destructive/10 text-destructive";
  return "bg-muted text-muted-foreground";
}

function opTone(op: string) {
  if (op === "drop") return "text-destructive";
  if (op === "create") return "text-emerald-600 dark:text-emerald-400";
  if (op === "alter") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

type Plan = { objects: DumpObject[]; selection: string[] | null; diff: SqlDiff | null; hasDump: boolean };

export function MigratorPanel() {
  const [jobs, setJobs] = useState<ImportJobView[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [openSql, setOpenSql] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Record<string, SqlOutcome>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [plans, setPlans] = useState<Record<string, Plan>>({});
  const [events, setEvents] = useState<Record<string, ImportEventView[]>>({});
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [versions, setVersions] = useState<Record<string, SqlVersionView[]>>({});
  const [failures, setFailures] = useState<Record<string, FailureStepView[]>>({});
  const [showFailures, setShowFailures] = useState<Record<string, boolean>>({});
  const [rollbacks, setRollbacks] = useState<Record<string, { sourceVersion: number | null; plan: RollbackPlan }>>({});
  const [verify, setVerify] = useState<Record<string, SmokeReport>>({});
  const [verifyRunKey, setVerifyRunKey] = useState(0);

  const refresh = useCallback(async () => {
    setBusy((b) => b ?? "list");
    try {
      const r = await listImportJobsFn();
      if (!r.ok) setErr(r.error ?? "Failed to load import jobs");
      else { setErr(null); setJobs(r.jobs); }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy((b) => (b === "list" ? null : b));
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [p, h, v, f] = await Promise.all([
        importJobPlanFn({ data: { id } }),
        importAuditHistoryFn({ data: { id } }),
        listSqlVersionsFn({ data: { id } }),
        importFailureDetailFn({ data: { id } }),
      ]);
      if (p.ok) {
        setPlans((s) => ({ ...s, [id]: { objects: p.objects, selection: p.selection, diff: p.diff, hasDump: p.hasDump } }));
        setPicked((s) => (s[id] ? s : { ...s, [id]: p.selection ?? p.objects.map((o) => o.key) }));
      }
      if (h.ok) setEvents((s) => ({ ...s, [id]: h.events }));
      if (v.ok) setVersions((s) => ({ ...s, [id]: v.versions }));
      if (f.ok) setFailures((s) => ({ ...s, [id]: f.failures }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);


  useEffect(() => { void refresh(); }, [refresh]);

  // Live progress over SSE — no polling. New audit rows and job-level changes
  // (status, pause, apply) are pushed by /api/import-events/:jobId.
  const stream = useImportEventStream(
    expanded,
    useCallback((incoming: ImportEventView[]) => {
      if (!incoming.length) return;
      const jobId = incoming[0].job_id;
      setEvents((s) => {
        const cur = s[jobId] ?? [];
        const known = new Set(cur.map((e) => e.id));
        const merged = [...cur, ...incoming.filter((e) => !known.has(e.id))];
        merged.sort((a, b) => a.created_at.localeCompare(b.created_at));
        return { ...s, [jobId]: merged };
      });
      // A terminal step changes derived data (versions, failures, diff).
      if (incoming.some((e) => ["apply", "dry_run", "rollback", "retry", "translated", "version_restored"].includes(e.step))) {
        void loadDetail(jobId);
      }
    }, [loadDetail]),
    useCallback((patch: LiveJobPatch) => {
      setJobs((js) => js.map((j) => (j.id === patch.id ? { ...j, ...patch } : j)));
    }, []),
  );

  function toggleRow(id: string) {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next) void loadDetail(next);
  }


  async function run(kind: "translate" | "dry" | "apply", job: ImportJobView) {
    setBusy(`${kind}:${job.id}`);
    try {
      if (kind === "translate") {
        const sel = picked[job.id];
        const r = await retranslateImportJob({ data: { id: job.id, selection: sel } });
        if (!r.ok) setErr(r.error);
        else {
          setErr(null);
          setOpenSql(r.sql);
          setPlans((s) => ({ ...s, [job.id]: { ...(s[job.id] ?? { objects: [], selection: null, hasDump: true }), diff: r.diff } as Plan }));
        }
      } else if (kind === "dry") {
        const res = await dryRunImportJob({ data: { id: job.id } });
        setOutcome((o) => ({ ...o, [job.id]: res }));
      } else {
        const d = plans[job.id]?.diff;
        const warn = d?.destructiveCount ? `\n\n⚠ ${d.destructiveCount} destructive statement(s) (drop/truncate).` : "";
        if (!confirm(`Apply migration for ${job.repo ?? job.event_id} to the live Pluto database?${warn}`)) return;
        const res = await applyImportJob({ data: { id: job.id, confirm: true } });
        setOutcome((o) => ({ ...o, [job.id]: res }));
      }
      await refresh();
      await loadDetail(job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function downloadExtension() {
    fetch(EXT_ZIP)
      .then((r) => { if (!r.ok) throw new Error(`Download failed: ${r.status}`); return r.blob(); })
      .then((b) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = "pluto-migrator-extension.zip";
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch((e) => setErr(e.message));
  }

  async function runVerification(job: ImportJobView) {
    setBusy(`verify:${job.id}`);
    try {
      const r = await runVerificationFn({ data: { id: job.id } });
      if (!r.report) setErr(r.error ?? "Verification failed");
      else {
        setErr(null);
        setVerify((s) => ({ ...s, [job.id]: r.report as SmokeReport }));
        setVerifyRunKey((k) => k + 1);
      }
      await loadDetail(job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function exportReport(job: ImportJobView, format: "json" | "pdf") {
    setBusy(`export:${job.id}`);
    try {
      const r = await buildImportReportFn({ data: { id: job.id, includeSql: format === "json" } });
      if (!r.bundle) { setErr(r.error ?? "Report failed"); return; }
      const bundle = r.bundle as ImportReportBundle;
      if (format === "json") downloadReportJson(bundle);
      else if (!openReportPdf(bundle)) setErr("Popup blocked — allow popups to save the PDF.");
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function loadRollback(job: ImportJobView, version?: number) {
    setBusy(`rb:${job.id}`);
    try {
      const r = await previewRollbackFn({ data: { id: job.id, version } });
      if (!r.ok || !r.plan) setErr(r.error ?? "Rollback preview failed");
      else {
        setErr(null);
        setRollbacks((s) => ({ ...s, [job.id]: { sourceVersion: r.sourceVersion, plan: r.plan as RollbackPlan } }));
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function runRollback(job: ImportJobView, dryRun: boolean) {
    const rb = rollbacks[job.id];
    if (!dryRun) {
      const warn = rb ? `\n\n${rb.plan.entries.length} object(s) will be dropped. ${rb.plan.unsupported.length} statement(s) cannot be undone (data inserts, drops).` : "";
      if (!confirm(`Roll back the applied import for ${job.repo ?? job.event_id}?${warn}`)) return;
    }
    setBusy(`rbrun:${job.id}`);
    try {
      const res = await runRollbackFn({ data: { id: job.id, version: rb?.sourceVersion ?? undefined, dryRun } });
      setOutcome((o) => ({ ...o, [job.id]: res }));
      await refresh();
      await loadDetail(job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function togglePause(job: ImportJobView) {
    setBusy(`pause:${job.id}`);
    try {
      const reason = job.paused ? undefined : (prompt("Reason for pausing (optional)") ?? undefined);
      const r = await setImportJobPaused({ data: { id: job.id, paused: !job.paused, reason } });
      if (!r.ok) setErr(r.error);
      await refresh();
      await loadDetail(job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function retry(job: ImportJobView) {
    setBusy(`retry:${job.id}`);
    try {
      const r = await retryImportJob({ data: { id: job.id } });
      if (!r.ok) setErr(r.error);
      else {
        setErr(null);
        if (r.dryRun) setOutcome((o) => ({ ...o, [job.id]: r.dryRun as SqlOutcome }));
        setPlans((s) => ({ ...s, [job.id]: { ...(s[job.id] ?? { objects: [], selection: null, hasDump: true }), diff: r.diff } as Plan }));
      }
      await refresh();
      await loadDetail(job.id);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  async function viewVersion(jobId: string, version: number) {
    try {
      const r = await getSqlVersionFn({ data: { id: jobId, version } });
      if (!r.ok) setErr(r.error);
      else { setErr(null); setOpenSql(r.sql); }
    } catch (e) { setErr((e as Error).message); }
  }

  async function restoreVersion(jobId: string, version: number) {
    if (!confirm(`Restore archived version v${version} as this job's current migration?`)) return;
    setBusy(`restore:${jobId}`);
    try {
      const r = await restoreSqlVersionFn({ data: { id: jobId, version } });
      if (!r.ok) setErr(r.error);
      else {
        setErr(null);
        setOpenSql(r.sql);
        setPlans((s) => ({ ...s, [jobId]: { ...(s[jobId] ?? { objects: [], selection: null, hasDump: true }), diff: r.diff } as Plan }));
      }
      await refresh();
      await loadDetail(jobId);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(null); }
  }

  function togglePick(jobId: string, key: string) {
    setPicked((s) => {

      const cur = s[jobId] ?? [];
      return { ...s, [jobId]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
    });
  }

  return (
    <section className="border rounded-lg p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium flex items-center gap-2"><Wand2 className="h-4 w-4" /> Pluto Migrator</h2>
          <p className="text-xs text-muted-foreground">
            Import a project from Lovable / GitHub / Supabase with the signed Chrome extension, pick what to bring over, review the diff, then dry-run and apply.
          </p>
        </div>
        <div className="flex gap-2">
          <Link to="/dashboard/import-audit" search={{ job: undefined }} className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1">
            <History className="h-4 w-4" /> Import audit
          </Link>
          <button className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1" onClick={downloadExtension}>
            <Download className="h-4 w-4" /> Download extension
          </button>
          <button className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1" onClick={() => void refresh()} disabled={busy === "list"}>
            <RefreshCw className={`h-4 w-4 ${busy === "list" ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </div>

      <div className="text-xs text-muted-foreground border rounded p-2 flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
        <span>
          Endpoint <code>/api/public/pluto-import</code> · HMAC-SHA256 over <code>{"<timestamp>.<body>"}</code> with{" "}
          <code>PLUTO_IMPORT_WEBHOOK_SECRET</code> · 5-minute window · duplicate <code>event_id</code> is ignored.
        </span>
      </div>

      {err && <div className="text-sm text-destructive">{err}</div>}

      <table className="w-full text-sm border rounded overflow-hidden">
        <thead className="bg-muted">
          <tr><th className="w-6" /><th className="text-left px-2 py-1">Source</th><th className="text-left">Repo / target</th><th>Status</th><th>Received</th><th></th></tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const plan = plans[j.id];
            const evs = events[j.id] ?? [];
            const sel = picked[j.id] ?? [];
            const isOpen = expanded === j.id;
            return (
              <>
                <tr key={j.id} className="border-t align-top">
                  <td className="px-1 py-1">
                    <button onClick={() => toggleRow(j.id)} aria-label="Toggle details">
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                  </td>
                  <td className="px-2 py-1">{j.source}</td>
                  <td className="px-2 py-1">
                    <div className="truncate max-w-[22rem]">{j.repo ?? j.slug ?? "—"}</div>
                    <div className="text-[11px] text-muted-foreground font-mono truncate max-w-[22rem]">{j.event_id}</div>
                    {j.applied_at && (
                      <div className="text-[11px] text-muted-foreground">
                        Applied {new Date(j.applied_at).toLocaleString()}{j.applied_by ? ` by ${j.applied_by}` : ""}
                      </div>
                    )}
                    {outcome[j.id] && (
                      <div className={`text-[11px] ${outcome[j.id].ok ? "text-primary" : "text-destructive"}`}>
                        {outcome[j.id].ok
                          ? `ok · ${outcome[j.id].rowCount} rows · ${outcome[j.id].durationMs}ms`
                          : `${outcome[j.id].error ?? "failed"}${outcome[j.id].detail ? ` — ${(outcome[j.id].detail ?? "").slice(0, 160)}` : ""}`}
                      </div>
                    )}
                  </td>
                  <td className="text-center">
                    <span className={`text-[11px] rounded px-2 py-0.5 ${statusTone(j.status)}`}>{j.status}</span>
                    {j.paused && (
                      <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-0.5">
                        paused{j.resume_step ? ` @ ${j.resume_step}` : ""}
                      </div>
                    )}
                  </td>
                  <td className="text-center text-xs text-muted-foreground">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="text-right space-x-2 pr-2 whitespace-nowrap">
                    <button className="underline" disabled={!!busy || j.paused} onClick={() => void run("translate", j)}>Re-translate</button>
                    <button className="underline" disabled={!!busy || !j.migration_sql || j.paused} onClick={() => void run("dry", j)}>Dry-run</button>
                    <button className="underline text-destructive inline-flex items-center gap-1" disabled={!!busy || !j.migration_sql || j.paused} onClick={() => void run("apply", j)}>
                      <Play className="h-3 w-3" /> Apply
                    </button>
                    <button className="underline inline-flex items-center gap-1" disabled={!!busy} onClick={() => void togglePause(j)}>
                      {j.paused ? <><Play className="h-3 w-3" /> Resume</> : <><Pause className="h-3 w-3" /> Pause</>}
                    </button>
                    <button className="underline inline-flex items-center gap-1" disabled={!!busy} onClick={() => void retry(j)}>
                      <RotateCcw className="h-3 w-3" /> Retry
                    </button>
                    <button className="underline" disabled={!j.migration_sql} onClick={() => setOpenSql(j.migration_sql)}>SQL</button>
                  </td>

                </tr>

                {isOpen && (
                  <tr key={`${j.id}-detail`} className="border-t bg-muted/30">
                    <td />
                    <td colSpan={5} className="p-3 space-y-4">
                      {/* Step-by-step progress */}
                      <div>
                        <div className="text-xs font-medium mb-1">Progress</div>
                        <div className="flex flex-wrap items-center gap-2">
                          {STEPS.map((step) => {
                            const last = [...evs].reverse().find((e) => e.step === step);
                            const tone = !last
                              ? "bg-muted text-muted-foreground"
                              : last.ok
                                ? "bg-primary/10 text-primary"
                                : "bg-destructive/10 text-destructive";
                            return (
                              <span key={step} className={`text-[11px] rounded px-2 py-0.5 inline-flex items-center gap-1 ${tone}`}>
                                {last ? (last.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />) : null}
                                {step.replace("_", "-")}
                              </span>
                            );
                          })}
                        </div>
                        <ol className="mt-2 space-y-1">
                          {evs.map((e) => (
                            <li key={e.id} className="text-[11px] flex flex-wrap gap-x-2">
                              <span className="text-muted-foreground">{new Date(e.created_at).toLocaleTimeString()}</span>
                              <span className={e.ok ? "" : "text-destructive"}>{e.step}</span>
                              <span className="text-muted-foreground">{e.actor_email ?? "webhook"}</span>
                              <span className="flex-1 min-w-[12rem]">{e.message}</span>
                              {e.duration_ms !== null && <span className="text-muted-foreground">{e.duration_ms}ms</span>}
                            </li>
                          ))}
                          {!evs.length && <li className="text-[11px] text-muted-foreground">No recorded steps yet.</li>}
                        </ol>
                        {evs.some((e) => !e.ok) && (
                          <div className="mt-1">
                            <Link to="/dashboard/import-audit" search={{ job: j.id }} className="text-[11px] underline text-destructive">
                              Open failure log →
                            </Link>
                          </div>
                        )}
                      </div>

                      {/* Failure analysis */}
                      {!!(failures[j.id] ?? []).length && (
                        <div className="border rounded bg-background p-2">
                          <button
                            className="text-xs font-medium inline-flex items-center gap-1 text-destructive"
                            onClick={() => setShowFailures((s) => ({ ...s, [j.id]: !s[j.id] }))}
                          >
                            <AlertTriangle className="h-3.5 w-3.5" />
                            Failure analysis ({(failures[j.id] ?? []).length})
                            {showFailures[j.id] ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          </button>
                          {showFailures[j.id] && (
                            <div className="mt-2 space-y-3">
                              {(failures[j.id] ?? []).map((f) => (
                                <div key={f.eventId} className="border rounded p-2 space-y-1">
                                  <div className="text-[11px] flex flex-wrap gap-x-2">
                                    <span className="text-destructive font-medium">{f.step}</span>
                                    <span className="text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</span>
                                    <span className="text-muted-foreground">{f.actorEmail ?? "webhook"}</span>
                                  </div>
                                  <div className="text-[11px]">{f.analysis.summary}</div>
                                  <div className="flex flex-wrap gap-1">
                                    {f.analysis.tags.map((t) => (
                                      <span
                                        key={t.code}
                                        title={t.hint}
                                        className={`text-[10px] rounded px-1.5 py-0.5 ${t.severity === "error" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-600 dark:text-amber-400"}`}
                                      >
                                        {t.label}
                                      </span>
                                    ))}
                                    {!f.analysis.tags.length && <span className="text-[10px] text-muted-foreground">No known root-cause pattern matched.</span>}
                                  </div>
                                  {f.analysis.tags.map((t) => (
                                    <div key={`${t.code}-hint`} className="text-[11px] text-muted-foreground">→ {t.hint}</div>
                                  ))}
                                  {f.analysis.snippet && (
                                    <pre className="text-[11px] font-mono bg-muted/50 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">
                                      {f.analysis.snippetIndex !== null ? `-- statement #${f.analysis.snippetIndex + 1}\n` : ""}{f.analysis.snippet}
                                    </pre>
                                  )}
                                  <details>
                                    <summary className="text-[11px] cursor-pointer text-muted-foreground">Raw error</summary>
                                    <pre className="text-[11px] font-mono max-h-32 overflow-auto whitespace-pre-wrap">{f.analysis.raw}</pre>
                                  </details>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Archived SQL versions */}
                      {!!(versions[j.id] ?? []).length && (
                        <div>
                          <div className="text-xs font-medium mb-1 inline-flex items-center gap-1">
                            <Archive className="h-3.5 w-3.5" /> SQL version archive ({(versions[j.id] ?? []).length})
                          </div>
                          <div className="max-h-48 overflow-auto border rounded bg-background">
                            <table className="w-full text-[11px]">
                              <tbody>
                                {(versions[j.id] ?? []).map((v) => (
                                  <tr key={v.id} className="border-t">
                                    <td className="px-2 py-0.5 w-12 font-mono">v{v.version}</td>
                                    <td className="px-2 py-0.5 w-20 text-muted-foreground">{v.kind}</td>
                                    <td className="px-2 py-0.5 text-muted-foreground whitespace-nowrap">{new Date(v.created_at).toLocaleString()}</td>
                                    <td className="px-2 py-0.5">
                                      {v.counts
                                        ? <>
                                            <span className={opTone("create")}>{v.counts.create ?? 0}c</span>{" "}
                                            <span className={opTone("alter")}>{v.counts.alter ?? 0}a</span>{" "}
                                            <span className={opTone("drop")}>{v.counts.drop ?? 0}d</span>
                                          </>
                                        : "—"}
                                      {!!v.destructive_count && <span className="text-destructive"> · {v.destructive_count} destructive</span>}
                                    </td>
                                    <td className="px-2 py-0.5 text-muted-foreground truncate max-w-[12rem]">{v.actor_email ?? "system"}{v.note ? ` · ${v.note}` : ""}</td>
                                    <td className="px-2 py-0.5 text-right whitespace-nowrap space-x-2">
                                      <button className="underline" onClick={() => void viewVersion(j.id, v.version)}>View</button>
                                      <button className="underline" disabled={!!busy} onClick={() => void restoreVersion(j.id, v.version)}>Restore</button>
                                      {v.kind === "apply" && (
                                        <button className="underline text-destructive" disabled={!!busy} onClick={() => void loadRollback(j, v.version)}>Undo…</button>
                                      )}
                                    </td>

                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Every translate / retry / apply archives the exact SQL, so you can re-review the same diff, restore it, or undo an applied version.
                          </p>
                        </div>
                      )}

                      {/* Post-apply verification: smoke tests / integrity checks */}
                      {(() => {
                        const rep = verify[j.id] ?? (() => {
                          try { return (JSON.parse(j.report ?? "{}") as { verification?: SmokeReport }).verification ?? null; }
                          catch { return null; }
                        })();
                        if (!rep && !j.applied_at) return null;
                        return (
                          <div className="border rounded p-2 bg-background">
                            <div className="flex items-center justify-between gap-2">
                              <div className="text-xs font-medium inline-flex items-center gap-1">
                                <ShieldCheck className="h-3.5 w-3.5" /> Verification
                                {rep && (
                                  <span className="font-normal">
                                    {" "}· <span className="text-primary">{rep.counts.pass} pass</span>
                                    {" "}· <span className={rep.counts.warn ? "text-amber-600" : "text-muted-foreground"}>{rep.counts.warn} warn</span>
                                    {" "}· <span className={rep.counts.fail ? "text-destructive" : "text-muted-foreground"}>{rep.counts.fail} fail</span>
                                  </span>
                                )}
                              </div>
                              <button className="text-xs underline" disabled={!!busy} onClick={() => void runVerification(j)}>
                                {busy === `verify:${j.id}` ? "Running…" : "Re-run checks"}
                              </button>
                            </div>
                            {rep ? (
                              <div className="mt-2 max-h-48 overflow-auto border rounded text-[11px]">
                                {rep.checks.map((c) => (
                                  <div key={c.id} className="flex gap-2 px-2 py-0.5 border-t first:border-t-0">
                                    <span className={c.status === "fail" ? "text-destructive" : c.status === "warn" ? "text-amber-600" : "text-primary"}>{c.status}</span>
                                    <span className="font-mono truncate max-w-[12rem]">{c.target}</span>
                                    <span className="text-muted-foreground">{c.label}</span>
                                    <span className="text-muted-foreground truncate">— {c.detail}</span>
                                  </div>
                                ))}
                                <div className="px-2 py-1 text-muted-foreground border-t">
                                  {rep.targets.length} object(s) · {rep.durationMs} ms · {new Date(rep.ranAt).toLocaleString()}
                                </div>
                              </div>
                            ) : (
                              <p className="text-[11px] text-muted-foreground mt-1">
                                Smoke tests run automatically right after a successful apply (existence, readability, row counts, RLS policies, primary keys, index/constraint validity) and are recorded on the timeline.
                              </p>
                            )}
                          </div>
                        );
                      })()}

                      <VerificationRunsCard jobId={j.id} refreshKey={verifyRunKey} />

                      {/* Downloadable report */}
                      <div className="border rounded p-2 bg-background flex items-center justify-between gap-2">
                        <div className="text-xs">
                          <span className="font-medium inline-flex items-center gap-1"><Download className="h-3.5 w-3.5" /> Export report</span>
                          <span className="text-muted-foreground"> — SQL version archive, apply diff, verification, step-wise errors and full timeline.</span>
                        </div>
                        <div className="space-x-2 text-xs whitespace-nowrap">
                          <button className="underline" disabled={!!busy} onClick={() => void exportReport(j, "json")}>
                            {busy === `export:${j.id}` ? "Building…" : "JSON"}
                          </button>
                          <button className="underline" disabled={!!busy} onClick={() => void exportReport(j, "pdf")}>PDF</button>
                        </div>
                      </div>


                      <ShareReportCard jobId={j.id} />

                      {/* Rollback / undo of an applied import */}
                      {(j.applied_at || j.status === "applied") && (
                        <div className="border rounded p-2 bg-background">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-medium inline-flex items-center gap-1">
                              <RotateCcw className="h-3.5 w-3.5" /> Rollback / undo
                              {rollbacks[j.id]?.sourceVersion != null && (
                                <span className="text-muted-foreground font-normal"> · from v{rollbacks[j.id].sourceVersion}</span>
                              )}
                            </div>
                            <div className="space-x-2 text-xs">
                              <button className="underline" disabled={!!busy} onClick={() => void loadRollback(j)}>
                                {busy === `rb:${j.id}` ? "Generating…" : "Generate undo SQL"}
                              </button>
                              {rollbacks[j.id] && (
                                <>
                                  <button className="underline" onClick={() => setOpenSql(rollbacks[j.id].plan.sql)}>View SQL</button>
                                  <button className="underline" disabled={!!busy} onClick={() => void runRollback(j, true)}>Dry-run</button>
                                  <button className="underline text-destructive" disabled={!!busy} onClick={() => void runRollback(j, false)}>
                                    {busy === `rbrun:${j.id}` ? "Working…" : "Run rollback"}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                          {rollbacks[j.id] ? (
                            <div className="mt-2 space-y-1 text-[11px]">
                              <div className="text-muted-foreground">
                                {rollbacks[j.id].plan.entries.length} invertible statement(s) — executed in reverse order.
                              </div>
                              <div className="max-h-40 overflow-auto border rounded">
                                {rollbacks[j.id].plan.entries.map((e, i) => (
                                  <div key={i} className="px-2 py-0.5 border-t first:border-t-0 font-mono truncate">
                                    <span className={opTone("drop")}>{e.objectType}</span> <span className="text-muted-foreground">{e.name}</span>
                                  </div>
                                ))}
                              </div>
                              {!!rollbacks[j.id].plan.unsupported.length && (
                                <div className="text-destructive">
                                  ⚠ {rollbacks[j.id].plan.unsupported.length} statement(s) cannot be undone automatically (data writes / drops). Review manually.
                                </div>
                              )}
                            </div>
                          ) : (
                            <p className="text-[11px] text-muted-foreground mt-1">
                              Builds an inverse script from the archived apply snapshot (created tables/columns/policies are dropped in reverse order).
                            </p>
                          )}
                        </div>
                      )}




                      {/* Object selection */}
                      {plan?.hasDump && (
                        <div>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs font-medium">Import selection ({sel.length}/{plan.objects.length})</span>
                            <span className="space-x-2 text-[11px]">
                              <button className="underline" onClick={() => setPicked((s) => ({ ...s, [j.id]: plan.objects.map((o) => o.key) }))}>All</button>
                              <button className="underline" onClick={() => setPicked((s) => ({ ...s, [j.id]: [] }))}>None</button>
                              <button className="underline" onClick={() => setPicked((s) => ({ ...s, [j.id]: plan.objects.filter((o) => o.kind === "table").map((o) => o.key) }))}>Tables only</button>
                            </span>
                          </div>
                          <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3 max-h-52 overflow-auto border rounded p-2 bg-background">
                            {plan.objects.map((o) => (
                              <label key={o.key} className="text-[11px] flex items-center gap-1 truncate">
                                <input type="checkbox" checked={sel.includes(o.key)} onChange={() => togglePick(j.id, o.key)} />
                                <span className="uppercase text-muted-foreground w-14 shrink-0">{o.kind}</span>
                                <span className="truncate">{o.schema}.{o.name}</span>
                                <span className="text-muted-foreground">({o.statements})</span>
                              </label>
                            ))}
                            {!plan.objects.length && <span className="text-[11px] text-muted-foreground">No objects detected in the dump.</span>}
                          </div>
                          <button
                            className="mt-2 px-2 py-1 text-xs rounded border"
                            disabled={!!busy}
                            onClick={() => void run("translate", j)}
                          >
                            Generate migration from selection
                          </button>
                        </div>
                      )}

                      {/* Diff */}
                      {plan?.diff && (
                        <div>
                          <div className="text-xs font-medium mb-1">
                            Change diff — <span className={opTone("create")}>{plan.diff.counts.create} create</span>,{" "}
                            <span className={opTone("alter")}>{plan.diff.counts.alter} alter</span>,{" "}
                            <span className={opTone("drop")}>{plan.diff.counts.drop} drop</span>
                            {plan.diff.destructiveCount > 0 && (
                              <span className="text-destructive"> · {plan.diff.destructiveCount} destructive</span>
                            )}
                          </div>
                          <div className="max-h-64 overflow-auto border rounded bg-background">
                            <table className="w-full text-[11px]">
                              <tbody>
                                {plan.diff.entries.map((d, i) => (
                                  <tr key={i} className="border-t">
                                    <td className={`px-2 py-0.5 w-16 uppercase ${opTone(d.op)}`}>{d.op}</td>
                                    <td className="px-2 py-0.5 w-28 text-muted-foreground">{d.objectType}</td>
                                    <td className="px-2 py-0.5 font-mono truncate max-w-[14rem]">{d.name}</td>
                                    <td className="px-2 py-0.5 font-mono text-muted-foreground truncate">{d.statement.slice(0, 140)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1">
                            Dry-run executes exactly these statements inside a transaction that is rolled back — nothing persists until you press Apply.
                          </p>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </>
            );
          })}
          {!jobs.length && (
            <tr><td colSpan={6} className="px-2 py-4 text-center text-xs text-muted-foreground">No imports yet — install the extension and send one.</td></tr>
          )}
        </tbody>
      </table>

      {openSql && (
        <div className="border rounded p-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium">Translated migration</span>
            <button className="text-xs underline" onClick={() => setOpenSql(null)}>Close</button>
          </div>
          <pre className="text-[11px] font-mono max-h-72 overflow-auto whitespace-pre-wrap">{openSql}</pre>
        </div>
      )}
    </section>
  );
}
