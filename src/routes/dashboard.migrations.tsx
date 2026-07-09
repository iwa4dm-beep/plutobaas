import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Download, Eye, Play, RotateCcw, ShieldAlert, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardMigrationsHelp } from "@/content/help/dashboard.migrations";
import {
  isLive, live, subscribe,
  type BootRun, type DryRunEntry, type MigrationEntry,
  type RealtimeAuthError, type RealtimeEvent, type RealtimeStatus,
} from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/migrations")({
  component: MigrationsPage,
});


const STATUS_COLOR: Record<MigrationEntry["status"], string> = {
  applied: "text-emerald-500 bg-emerald-500/10 border-emerald-500/30",
  pending: "text-amber-500 bg-amber-500/10 border-amber-500/30",
  drift: "text-orange-500 bg-orange-500/10 border-orange-500/30",
  rolled_back: "text-sky-500 bg-sky-500/10 border-sky-500/30",
  failed: "text-red-500 bg-red-500/10 border-red-500/30",
  missing: "text-muted-foreground bg-muted/40 border-border",
};

type ProgressEntry = { ts: string; event: string; text: string };

function MigrationsPage() {
  const [entries, setEntries] = useState<MigrationEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [plan, setPlan] = useState<DryRunEntry[] | null>(null);
  const [progress, setProgress] = useState<ProgressEntry[]>([]);
  const [liveConn, setLiveConn] = useState(false);
  const [authErr, setAuthErr] = useState<{ code: RealtimeAuthError; message: string } | null>(null);
  const [bootRun, setBootRun] = useState<BootRun | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) {
        setEntries([]);
        setErr("Backend not configured — set VITE_PLUTO_URL & VITE_PLUTO_ANON_KEY.");
        return;
      }
      const [{ migrations }, boot] = await Promise.all([
        live.migrations.list(),
        live.migrations.lastBoot().catch(() => ({ run: null as BootRun | null })),
      ]);
      setEntries(migrations);
      setBootRun(boot.run);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live progress: subscribe to the migrations broadcast channel.
  useEffect(() => {
    if (!isLive()) return;
    const push = (e: RealtimeEvent) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      const bits: string[] = [];
      if (p.version) bits.push(String(p.version));
      if (p.phase) bits.push(String(p.phase));
      if (p.duration_ms) bits.push(`${p.duration_ms}ms`);
      if (p.error) bits.push(`error: ${p.error}`);
      if (p.total != null) bits.push(`${p.total} version(s)`);
      if (p.applied) bits.push(`applied ${(p.applied as string[]).length}`);
      setProgress((prev) => [{ ts: e.ts ?? new Date().toISOString(), event: e.event, text: bits.join(" · ") }, ...prev].slice(0, 40));
      // Any run.done / rollback.done event should refresh the list.
      if (e.event === "run.done" || e.event.endsWith(".done") || e.event === "step") void load();
    };
    const off = subscribe("system:migrations", push, {
      onStatus: (s: RealtimeStatus) => {
        if (s.kind === "open") { setLiveConn(true); setAuthErr(null); }
        else if (s.kind === "auth_error") { setLiveConn(false); setAuthErr({ code: s.error, message: s.message }); }
        else setLiveConn(false);
      },
    });
    return () => { off(); setLiveConn(false); };
  }, [load]);


  async function guard<T>(key: string, fn: () => Promise<T>) {
    setBusy(key); setErr(null); setNote(null);
    try { const r = await fn(); await load(); return r; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  async function preview() {
    setBusy("plan"); setErr(null); setNote(null);
    try {
      if (!isLive()) throw new Error("Pluto backend not configured.");
      const res = await live.migrations.dryRun();
      setPlan(res.plan);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  // Export the dry-run plan as JSON (structured), plain text (human report),
  // or an executable .sql file (concatenated statements wrapped in a single
  // transaction). All three are generated client-side from the plan that
  // /admin/v1/migrations/dry-run already returned — no extra endpoint calls.
  function exportPlan(kind: "json" | "text" | "sql") {
    if (!plan) return;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    if (kind === "json") {
      const blob = new Blob([JSON.stringify({ generated_at: new Date().toISOString(), plan }, null, 2)], { type: "application/json" });
      triggerDownload(blob, `pluto-dryrun-${ts}.json`);
      return;
    }
    if (kind === "sql") {
      const out: string[] = [];
      out.push(`-- Pluto migration dry-run · generated ${new Date().toISOString()}`);
      out.push(`-- ${plan.length} migration(s). Review carefully before applying.`);
      out.push(`-- Wrap the whole batch in a transaction so a mid-run failure rolls everything back.`);
      out.push("");
      out.push("BEGIN;");
      out.push("");
      for (const p of plan) {
        out.push(`-- ══ ${p.version} · ${p.name} ══════════════════════════════`);
        out.push(`-- reason=${p.reason}  statements=${p.statement_count}  bytes=${p.bytes}  down=${p.has_down}`);
        if (p.diff.added.length)   out.push(`-- +added   : ${p.diff.added.join(", ")}`);
        if (p.diff.removed.length) out.push(`-- -removed : ${p.diff.removed.join(", ")}`);
        if (p.diff.changed.length) out.push(`-- ~changed : ${p.diff.changed.join(", ")}`);
        if (p.simulation_error)    out.push(`-- ⚠  SIMULATION ERROR (would abort): ${p.simulation_error}`);
        out.push("");
        out.push(p.preview.trim());
        out.push("");
        out.push(`-- Record apply in ledger. Server does this automatically; kept here for parity if executed manually.`);
        out.push(`INSERT INTO public.schema_migrations (version, name, checksum, applied_at)`);
        out.push(`  VALUES ('${p.version}', '${p.name.replace(/'/g, "''")}', 'MANUAL-APPLY', now())`);
        out.push(`  ON CONFLICT (version) DO NOTHING;`);
        out.push("");
      }
      out.push("COMMIT;");
      out.push("");
      triggerDownload(new Blob([out.join("\n")], { type: "application/sql" }), `pluto-dryrun-${ts}.sql`);
      return;
    }
    const lines: string[] = [];
    lines.push(`Pluto migration dry-run · ${new Date().toISOString()}`);
    lines.push(`${plan.length} migration(s) would run.`);
    lines.push("");
    for (const p of plan) {
      lines.push(`── ${p.version} (${p.name}) ─────────────────────────────`);
      lines.push(`reason=${p.reason}  statements=${p.statement_count}  bytes=${p.bytes}  down=${p.has_down}`);
      lines.push(`schema before=${p.before_snapshot_size} after=${p.after_snapshot_size}`);
      if (p.simulation_error) lines.push(`SIMULATION ERROR: ${p.simulation_error}`);
      lines.push(`+added   (${p.diff.added.length}): ${p.diff.added.join(", ") || "—"}`);
      lines.push(`-removed (${p.diff.removed.length}): ${p.diff.removed.join(", ") || "—"}`);
      lines.push(`~changed (${p.diff.changed.length}): ${p.diff.changed.join(", ") || "—"}`);
      lines.push("Statements:");
      for (const s of p.statements) lines.push(`  [${s.index}] ${s.kind}  ${s.target ?? ""}`);
      lines.push("--- SQL preview ---");
      lines.push(p.preview);
      lines.push("");
    }
    triggerDownload(new Blob([lines.join("\n")], { type: "text/plain" }), `pluto-dryrun-${ts}.txt`);
  }


  const pendingCount = (entries ?? []).filter((e) => e.status === "pending" || e.status === "failed" || e.status === "rolled_back").length;


  return (
    <div>
      <PageHeader
        title="Database migrations"
        description="Version history, pending runs, rollback, and live progress for the Pluto schema."
      />
      <HelpPanel help={dashboardMigrationsHelp} />

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <button
          disabled={!isLive() || busy !== null || pendingCount === 0}
          onClick={preview}
          className="inline-flex items-center gap-2 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
        >
          <Eye className="h-4 w-4" />
          Preview (dry-run)
        </button>
        <button
          disabled={!isLive() || busy !== null || pendingCount === 0}
          onClick={() => guard("run", () => live.migrations.runPending())}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm disabled:opacity-50"
        >
          <Play className="h-4 w-4" />
          Run {pendingCount || "no"} pending migration{pendingCount === 1 ? "" : "s"}
        </button>
        <button
          disabled={busy !== null}
          onClick={() => void load()}
          className="rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent"
        >
          Refresh
        </button>
        {isLive() && (
          <span className={`text-xs inline-flex items-center gap-1.5 ${liveConn ? "text-emerald-500" : "text-muted-foreground"}`}>
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${liveConn ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            {liveConn ? "live" : "connecting…"}
          </span>
        )}
      </div>

      {/* Realtime authorization failure — surfaced by openSocket. Retries
          are suspended until the operator updates credentials. */}
      {authErr && (
        <div className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5" />
          <div className="flex-1">
            <div className="font-medium">Realtime disabled — {authErr.code}</div>
            <div className="text-xs mt-0.5">{authErr.message} Live progress will resume after you refresh with updated credentials.</div>
          </div>
        </div>
      )}

      {/* Last container-boot migration run — see src/db/migrate.ts */}
      {bootRun && <BootRunCard run={bootRun} />}

      {plan && (
        <div className="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div className="text-sm font-medium">
              Dry-run plan · {plan.length} migration{plan.length === 1 ? "" : "s"} would run
              <span className="ml-2 text-xs text-muted-foreground">
                (simulated in a transaction; nothing was written)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => exportPlan("json")}
                disabled={plan.length === 0}
                className="inline-flex items-center gap-1 text-xs rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> JSON
              </button>
              <button
                onClick={() => exportPlan("text")}
                disabled={plan.length === 0}
                className="inline-flex items-center gap-1 text-xs rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> Text
              </button>
              <button
                onClick={() => exportPlan("sql")}
                disabled={plan.length === 0}
                title="Download an executable .sql file wrapped in BEGIN/COMMIT"
                className="inline-flex items-center gap-1 text-xs rounded-md border border-primary/40 bg-primary/10 text-primary px-2 py-1 hover:bg-primary/20 disabled:opacity-40"
              >
                <Download className="h-3 w-3" /> SQL
              </button>

              <button onClick={() => setPlan(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
            </div>
          </div>

          {plan.length === 0 ? (
            <div className="text-xs text-muted-foreground">Nothing pending — schema is up to date.</div>
          ) : (
            <ul className="space-y-3">
              {plan.map((p) => (
                <li key={p.version} className="rounded-md border border-border bg-card p-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono">{p.version}</span>
                    <span className="text-muted-foreground">
                      · {p.reason} · {p.statement_count} stmt · {p.bytes}B
                    </span>
                    {p.has_down && <span className="text-emerald-500">· rollback available</span>}
                    {p.simulation_error && <span className="text-red-500">· simulation error</span>}
                    {!p.simulation_error && (
                      <span className="text-muted-foreground">
                        · schema {p.before_snapshot_size} → {p.after_snapshot_size}
                      </span>
                    )}
                  </div>

                  {p.simulation_error && (
                    <div className="mt-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded p-2">
                      {p.simulation_error}
                    </div>
                  )}

                  {/* Per-statement classification */}
                  {p.statements.length > 0 && (
                    <div className="mt-2">
                      <div className="text-[11px] text-muted-foreground mb-1">Statements</div>
                      <ul className="text-[11px] font-mono space-y-0.5">
                        {p.statements.map((s) => (
                          <li key={s.index} className="flex items-start gap-2">
                            <span className="inline-block min-w-[8ch] text-primary">{s.kind}</span>
                            <span className="text-muted-foreground">{s.target ?? ""}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Schema diff — before / after symmetric difference */}
                  {(p.diff.added.length + p.diff.removed.length + p.diff.changed.length) > 0 && (
                    <div className="mt-2 grid gap-2 md:grid-cols-3">
                      <DiffColumn title="Added"   items={p.diff.added}   className="text-emerald-500 bg-emerald-500/5 border-emerald-500/30" prefix="+ " />
                      <DiffColumn title="Removed" items={p.diff.removed} className="text-red-500 bg-red-500/5 border-red-500/30"             prefix="- " />
                      <DiffColumn title="Changed" items={p.diff.changed} className="text-amber-500 bg-amber-500/5 border-amber-500/30"       prefix="~ " />
                    </div>
                  )}

                  <details className="mt-2">
                    <summary className="text-[11px] text-muted-foreground cursor-pointer hover:text-foreground">Show SQL preview</summary>
                    <pre className="mt-2 text-[11px] bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap">{p.preview}{p.bytes > 400 ? "…" : ""}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}


      {progress.length > 0 && (
        <div className="mb-4 rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium mb-2">Live progress</div>
          <ul className="text-xs font-mono space-y-0.5 max-h-40 overflow-y-auto">
            {progress.map((p, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="text-foreground/80">{new Date(p.ts).toLocaleTimeString()}</span>
                {" "}<span className="text-primary">{p.event}</span>
                {" "}{p.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {note && <div className="mb-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">{note}</div>}
      {err && <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{err}</div>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Version</th>
              <th className="text-left px-3 py-2 font-medium">Status</th>
              <th className="text-left px-3 py-2 font-medium">Applied</th>
              <th className="text-left px-3 py-2 font-medium">Duration</th>
              <th className="text-right px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.version} className="border-t border-border">
                <td className="px-3 py-2">
                  <div className="font-mono text-xs">{e.version}</div>
                  <div className="text-xs text-muted-foreground">{e.name}</div>
                  {e.error && <div className="text-xs text-red-500 mt-1">{e.error}</div>}
                  {e.status === "drift" && (
                    <div className="text-xs text-orange-500 mt-1">File checksum differs from applied version — re-run to sync.</div>
                  )}
                </td>
                <td className="px-3 py-2">
                  <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${STATUS_COLOR[e.status]}`}>
                    <StatusIcon status={e.status} />
                    {e.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {e.applied_at ? new Date(e.applied_at).toLocaleString() : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {e.duration_ms != null ? `${e.duration_ms}ms` : "—"}
                </td>
                <td className="px-3 py-2 text-right space-x-2 whitespace-nowrap">
                  {(e.status === "applied" || e.status === "drift") && e.has_down && (
                    <button
                      disabled={!isLive() || busy !== null}
                      onClick={() => guard(`rb-${e.version}`, () => live.migrations.rollback(e.version))}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" /> Rollback
                    </button>
                  )}
                  {e.status !== "missing" && (
                    <button
                      disabled={!isLive() || busy !== null}
                      onClick={() => guard(`re-${e.version}`, () => live.migrations.rerun(e.version))}
                      className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                    >
                      <Play className="h-3 w-3" /> Re-run
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {entries && entries.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground" colSpan={5}>No migrations found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
        <strong>Strategy.</strong> Files under <code>db/migrations/</code> are the source of truth.
        Each file's sha256 is stored in <code>public.schema_migrations</code>. Files edited after
        deployment show as <em>drift</em>; use <em>Re-run</em> to apply the new body. To reverse a
        migration, embed a <code>-- +migrate down</code> block and use <em>Rollback</em>.
      </p>
    </div>
  );
}

function StatusIcon({ status }: { status: MigrationEntry["status"] }) {
  if (status === "applied") return <CheckCircle2 className="h-3 w-3" />;
  if (status === "pending" || status === "rolled_back") return <Clock className="h-3 w-3" />;
  if (status === "failed" || status === "missing") return <XCircle className="h-3 w-3" />;
  return <AlertTriangle className="h-3 w-3" />;
}

function DiffColumn({ title, items, className, prefix }: { title: string; items: string[]; className: string; prefix: string }) {
  return (
    <div className={`rounded border p-2 ${className}`}>
      <div className="text-[11px] font-medium mb-1">{title} ({items.length})</div>
      {items.length === 0 ? (
        <div className="text-[11px] opacity-60">—</div>
      ) : (
        <ul className="text-[11px] font-mono space-y-0.5 max-h-40 overflow-y-auto">
          {items.map((v, i) => <li key={i} className="truncate" title={v}>{prefix}{v}</li>)}
        </ul>
      )}
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// "Last boot" widget: renders the most recent container-startup
// migration attempt as recorded by src/db/migrate.ts under
// PLUTO_BOOT_ACTOR=boot. Useful for post-deploy verification.
function BootRunCard({ run }: { run: BootRun }) {
  const ok = run.status === "ok";
  return (
    <div className={`mb-4 rounded-lg border p-4 ${ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"}`}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">Last boot run</span>
        <span className={`text-xs px-1.5 py-0.5 rounded ${ok ? "bg-emerald-500/10 text-emerald-500" : "bg-red-500/10 text-red-500"}`}>{run.status}</span>
        <span className="text-xs text-muted-foreground">mode={run.mode}</span>
        <span className="text-xs text-muted-foreground">host={run.host ?? "—"}</span>
        <span className="text-xs text-muted-foreground">{run.duration_ms}ms</span>
        {!run.lock_acquired && <span className="text-xs text-amber-500">no lock</span>}
        <span className="text-xs text-muted-foreground ml-auto">
          {new Date(run.started_at).toLocaleString()}
        </span>
      </div>
      <div className="grid gap-2 md:grid-cols-4 mt-3 text-xs">
        <BootStat label="Pending"  items={run.pending} tone="text-muted-foreground" />
        <BootStat label="Drift"    items={run.drift}   tone="text-amber-500" />
        <BootStat label="Applied"  items={run.applied} tone="text-emerald-500" />
        <BootStat label="Failed"   items={run.failed.map(f => `${f.version}: ${f.error}`)} tone="text-red-500" />
      </div>
      {run.error && (
        <div className="mt-2 text-xs text-red-500 bg-red-500/10 border border-red-500/20 rounded p-2 whitespace-pre-wrap">{run.error}</div>
      )}
    </div>
  );
}

function BootStat({ label, items, tone }: { label: string; items: string[]; tone: string }) {
  return (
    <div className="rounded border border-border bg-card p-2">
      <div className="text-[11px] font-medium mb-1">{label} ({items.length})</div>
      {items.length === 0 ? (
        <div className="text-[11px] opacity-60">—</div>
      ) : (
        <ul className={`text-[11px] font-mono space-y-0.5 max-h-24 overflow-y-auto ${tone}`}>
          {items.map((v, i) => <li key={i} className="truncate" title={v}>{v}</li>)}
        </ul>
      )}
    </div>
  );
}

