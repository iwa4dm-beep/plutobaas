import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Clock, History, Lock, Play, RotateCcw, Unlock } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, type SqlHistoryEntry, type SqlResult, type SqlRunResponse } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/sql")({
  component: SqlRunnerPage,
});

const SAMPLE = "-- Ctrl/⌘+Enter to run\nselect table_schema, table_name\n  from information_schema.tables\n where table_schema = 'public'\n order by table_name;";

function SqlRunnerPage() {
  const [sql, setSql] = useState(SAMPLE);
  const [readOnly, setReadOnly] = useState(true);
  const [confirmWrite, setConfirmWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SqlRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SqlHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const backendOk = isLive();
  const canWrite = !readOnly && confirmWrite;

  const loadHistory = useCallback(async () => {
    if (!backendOk) return;
    setHistoryLoading(true);
    try {
      const page = await live.sql.history({ limit: 30 });
      setHistory(page.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHistoryLoading(false);
    }
  }, [backendOk]);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const run = useCallback(async () => {
    if (!backendOk) { setError("Configure VITE_PLUTO_URL & VITE_PLUTO_SERVICE_KEY to run SQL."); return; }
    if (!readOnly && !confirmWrite) { setError("Write mode requires the confirmation checkbox."); return; }
    setError(null);
    setBusy(true);
    try {
      const res = await live.sql.run(sql, { read_only: readOnly });
      setResult(res);
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
      await loadHistory();
    } finally {
      setBusy(false);
    }
  }, [backendOk, sql, readOnly, confirmWrite, loadHistory]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void run(); }
  };

  const rerun = useCallback(async (id: string) => {
    try {
      const entry = await live.sql.historyEntry(id);
      setSql(entry.sql);
      setReadOnly(entry.read_only);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  return (
    <div>
      <PageHeader
        title="SQL runner"
        description="Read-only mode wraps every run in a rolled-back transaction. Write mode requires explicit confirmation and admin credentials."
      />

      {!backendOk && (
        <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5" />
          <div>
            Backend not configured — set <code>VITE_PLUTO_URL</code> and <code>VITE_PLUTO_SERVICE_KEY</code> in the dashboard environment to enable this page.
          </div>
        </div>
      )}

      <div className="grid lg:grid-cols-[1fr_320px] gap-4">
        <section className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2">
            <button
              onClick={() => setReadOnly((v) => !v)}
              className={
                "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium border transition-colors " +
                (readOnly
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                  : "bg-red-500/10 text-red-300 border-red-500/30")
              }
              title="Toggle read-only enforcement"
            >
              {readOnly ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
              {readOnly ? "Read-only" : "Write mode"}
            </button>

            {!readOnly && (
              <label className="flex items-center gap-1.5 text-xs text-red-200">
                <input
                  type="checkbox"
                  checked={confirmWrite}
                  onChange={(e) => setConfirmWrite(e.target.checked)}
                  className="accent-red-500"
                />
                I understand this can modify data
              </label>
            )}

            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => void run()}
                disabled={busy || (!readOnly && !confirmWrite) || !backendOk}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                {busy ? "Running…" : `Run${readOnly ? " (read-only)" : ""}`}
              </button>
            </div>
          </div>

          <textarea
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className="w-full min-h-[240px] px-3 py-2 bg-background text-foreground font-mono text-[13px] leading-5 outline-none resize-vertical"
          />

          {error && (
            <div className="border-t border-border bg-red-500/5 px-3 py-2 text-sm text-red-300 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5" />
              <pre className="whitespace-pre-wrap font-mono text-xs">{error}</pre>
            </div>
          )}

          {result && (
            <div className="border-t border-border">
              <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-3">
                <span>{result.results.length} statement{result.results.length === 1 ? "" : "s"}</span>
                <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{result.duration_ms} ms</span>
                {result.read_only && <span className="text-emerald-400">rolled back (read-only)</span>}
              </div>
              {result.results.map((r, i) => (
                <ResultTable key={i} result={r} index={i} />
              ))}
            </div>
          )}
        </section>

        <aside className="rounded-lg border border-border bg-card overflow-hidden flex flex-col max-h-[720px]">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="inline-flex items-center gap-1.5 text-sm font-medium">
              <History className="h-4 w-4" /> History
            </div>
            <button
              onClick={() => void loadHistory()}
              className="text-xs text-muted-foreground hover:text-foreground"
              title="Refresh"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-border text-xs">
            {historyLoading && <div className="p-3 text-muted-foreground">Loading…</div>}
            {!historyLoading && history.length === 0 && (
              <div className="p-3 text-muted-foreground">No runs yet.</div>
            )}
            {history.map((h) => (
              <button
                key={h.id}
                onClick={() => void rerun(h.id)}
                className="w-full text-left px-3 py-2 hover:bg-accent/60 focus:bg-accent/60 focus:outline-none"
                title="Load into editor"
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className={h.status === "ok" ? "text-emerald-400" : "text-red-400"}>
                    {h.status}
                  </span>
                  <span className="text-muted-foreground">
                    {h.duration_ms}ms · {h.row_count ?? "—"} rows
                  </span>
                </div>
                <div className="text-[11px] text-muted-foreground truncate">
                  {new Date(h.ran_at).toLocaleString()} · {h.user_email ?? "system"} {h.read_only && "· read-only"}
                </div>
                <pre className="mt-1 font-mono text-[11px] leading-4 truncate text-foreground/80">
                  {h.sql_preview.split("\n").find((l) => l.trim())?.slice(0, 80) ?? h.sql_preview.slice(0, 80)}
                </pre>
              </button>
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ResultTable({ result, index }: { result: SqlResult; index: number }) {
  const cols = useMemo(() => result.columns.map((c) => c.name), [result.columns]);
  return (
    <div className="border-t border-border">
      <div className="px-3 py-1.5 text-xs text-muted-foreground bg-muted/30 flex items-center gap-3">
        <span>#{index + 1}</span>
        <span>{result.command ?? "(no command)"}</span>
        <span>{result.row_count ?? 0} rows</span>
        {result.truncated && <span className="text-amber-400">truncated at 5000</span>}
      </div>
      {cols.length > 0 && result.rows.length > 0 ? (
        <div className="overflow-x-auto max-h-[360px]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr>
                {cols.map((c) => (
                  <th key={c} className="text-left font-medium px-3 py-1.5 border-b border-border">{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} className="odd:bg-muted/10">
                  {cols.map((c) => (
                    <td key={c} className="px-3 py-1 font-mono text-[11px] max-w-[360px] truncate align-top">
                      {fmtCell((row as Record<string, unknown>)[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="px-3 py-2 text-xs text-muted-foreground">No rows returned.</div>
      )}
    </div>
  );
}

function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "∅";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
