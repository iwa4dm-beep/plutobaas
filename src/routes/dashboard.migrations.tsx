import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Eye, Play, RotateCcw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, subscribe, type DryRunEntry, type MigrationEntry, type RealtimeEvent } from "@/lib/pluto/live";

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

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) {
        setEntries(mockEntries);
        setNote("Showing sample data — configure VITE_PLUTO_URL & VITE_PLUTO_ANON_KEY to run against a live Pluto instance.");
        return;
      }
      const { migrations } = await live.migrations.list();
      setEntries(migrations);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live progress: subscribe to the migrations broadcast channel.
  useEffect(() => {
    if (!isLive()) return;
    setLiveConn(true);
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
    const off = subscribe("system:migrations", push);
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

  const pendingCount = (entries ?? []).filter((e) => e.status === "pending" || e.status === "failed" || e.status === "rolled_back").length;

  return (
    <div>
      <PageHeader
        title="Database migrations"
        description="Version history, pending runs, rollback, and live progress for the Pluto schema."
      />

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

      {plan && (
        <div className="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/5 p-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-medium">
              Dry-run plan · {plan.length} migration{plan.length === 1 ? "" : "s"} would run
              <span className="ml-2 text-xs text-muted-foreground">
                (simulated in a transaction; nothing was written)
              </span>
            </div>
            <button onClick={() => setPlan(null)} className="text-xs text-muted-foreground hover:text-foreground">Dismiss</button>
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

const mockEntries: MigrationEntry[] = [
  { version: "0001_init", name: "init", status: "applied", file_checksum: "abc", db_checksum: "abc", applied_at: new Date(Date.now() - 86400000 * 30).toISOString(), duration_ms: 240, has_down: false, error: null },
  { version: "0002_rls_helpers", name: "rls_helpers", status: "applied", file_checksum: "def", db_checksum: "def", applied_at: new Date(Date.now() - 86400000 * 20).toISOString(), duration_ms: 88, has_down: false, error: null },
  { version: "0003_phase5", name: "phase5", status: "drift", file_checksum: "111", db_checksum: "222", applied_at: new Date(Date.now() - 86400000 * 5).toISOString(), duration_ms: 130, has_down: false, error: null },
  { version: "0004_phase6", name: "phase6", status: "pending", file_checksum: "999", db_checksum: null, applied_at: null, duration_ms: null, has_down: true, error: null },
];
