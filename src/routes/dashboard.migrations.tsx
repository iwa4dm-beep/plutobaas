import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Play, RotateCcw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, type MigrationEntry } from "@/lib/pluto/live";

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

function MigrationsPage() {
  const [entries, setEntries] = useState<MigrationEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

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

  async function guard<T>(key: string, fn: () => Promise<T>) {
    setBusy(key); setErr(null); setNote(null);
    try { const r = await fn(); await load(); return r; }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  const pendingCount = (entries ?? []).filter((e) => e.status === "pending" || e.status === "failed" || e.status === "rolled_back").length;

  return (
    <div>
      <PageHeader
        title="Database migrations"
        description="Version history, pending runs, and rollback for the Pluto schema."
      />

      <div className="flex flex-wrap items-center gap-3 mb-4">
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
        {!isLive() && (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
            <AlertTriangle className="h-3.5 w-3.5" /> Read-only preview
          </span>
        )}
      </div>

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

const mockEntries: MigrationEntry[] = [
  { version: "0001_init", name: "init", status: "applied", file_checksum: "abc", db_checksum: "abc", applied_at: new Date(Date.now() - 86400000 * 30).toISOString(), duration_ms: 240, has_down: false, error: null },
  { version: "0002_rls_helpers", name: "rls_helpers", status: "applied", file_checksum: "def", db_checksum: "def", applied_at: new Date(Date.now() - 86400000 * 20).toISOString(), duration_ms: 88, has_down: false, error: null },
  { version: "0003_phase5", name: "phase5", status: "drift", file_checksum: "111", db_checksum: "222", applied_at: new Date(Date.now() - 86400000 * 5).toISOString(), duration_ms: 130, has_down: false, error: null },
  { version: "0004_phase6", name: "phase6", status: "pending", file_checksum: "999", db_checksum: null, applied_at: null, duration_ms: null, has_down: true, error: null },
];
