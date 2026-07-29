// Pluto Migrator panel — lists signed import jobs sent by the Chrome
// extension and lets an admin select objects, review the SQL diff, dry-run
// and apply each migration. Every step is recorded in the import audit trail.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ChevronDown, ChevronRight, Download, History, Play, RefreshCw, ShieldCheck, Wand2, XCircle } from "lucide-react";
import {
  applyImportJob,
  dryRunImportJob,
  importAuditHistoryFn,
  importJobPlanFn,
  listImportJobsFn,
  retranslateImportJob,
  type ImportEventView,
  type ImportJobView,
  type SqlOutcome,
} from "@/lib/pluto/import-job.functions";
import type { DumpObject } from "@/lib/pluto/supabase-objects";
import type { SqlDiff } from "@/lib/pluto/sql-diff";

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
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

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
      const [p, h] = await Promise.all([
        importJobPlanFn({ data: { id } }),
        importAuditHistoryFn({ data: { id } }),
      ]);
      if (p.ok) {
        setPlans((s) => ({ ...s, [id]: { objects: p.objects, selection: p.selection, diff: p.diff, hasDump: p.hasDump } }));
        setPicked((s) => (s[id] ? s : { ...s, [id]: p.selection ?? p.objects.map((o) => o.key) }));
      }
      if (h.ok) setEvents((s) => ({ ...s, [id]: h.events }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live progress: while a row is open, re-poll its timeline.
  useEffect(() => {
    if (poll.current) clearInterval(poll.current);
    if (!expanded) return;
    poll.current = setInterval(() => { void loadDetail(expanded); }, 4000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [expanded, loadDetail]);

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
          <Link to="/dashboard/import-audit" className="px-3 py-2 text-sm rounded border inline-flex items-center gap-1">
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
                  <td className="text-center"><span className={`text-[11px] rounded px-2 py-0.5 ${statusTone(j.status)}`}>{j.status}</span></td>
                  <td className="text-center text-xs text-muted-foreground">{new Date(j.created_at).toLocaleString()}</td>
                  <td className="text-right space-x-2 pr-2 whitespace-nowrap">
                    <button className="underline" disabled={!!busy} onClick={() => void run("translate", j)}>Re-translate</button>
                    <button className="underline" disabled={!!busy || !j.migration_sql} onClick={() => void run("dry", j)}>Dry-run</button>
                    <button className="underline text-destructive inline-flex items-center gap-1" disabled={!!busy || !j.migration_sql} onClick={() => void run("apply", j)}>
                      <Play className="h-3 w-3" /> Apply
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
