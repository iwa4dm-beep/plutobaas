// Real-time viewer of deployer/nginx repair tail + hint logs, sourced from
// the sandbox worker's /admin/repair/history endpoint via getRepairHistory.
// Polls every 3s while `live` is on. Filters by current slug when provided.
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getRepairHistory, type WorkerJson } from "@/lib/pluto/slug-secrets.functions";
import { Activity, Pause, Play, RefreshCw, Terminal } from "lucide-react";

type Entry = {
  action?: string;
  slug?: string | null;
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  startedAt?: string;
  finishedAt?: string;
  tail?: string;
  hint?: string | null;
};

type Props = {
  slug?: string;
  refreshKey?: number;
};

export function LiveRepairLogsPanel({ slug, refreshKey }: Props) {
  const load = useServerFn(getRepairHistory);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<"this-slug" | "all">("this-slug");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const filterSlug = scope === "this-slug" && slug ? slug : undefined;

  const fetchNow = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = (await load({ data: { slug: filterSlug, limit: 30 } })) as WorkerJson;
      if (r.ok === false) setError(r.error || `HTTP ${r.status ?? "?"}`);
      else setEntries(Array.isArray(r.entries) ? (r.entries as Entry[]) : []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    fetchNow();
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [refreshKey, filterSlug]);

  useEffect(() => {
    if (!live) return;
    const tick = () => {
      fetchNow().finally(() => { timer.current = setTimeout(tick, 3000); });
    };
    timer.current = setTimeout(tick, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [live, filterSlug]);

  const rows = useMemo(() => entries.slice(0, 30), [entries]);

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Terminal className="h-4 w-4" />
          Live repair logs
          {live && <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400"><Activity className="h-3 w-3 animate-pulse" /> streaming</span>}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {slug && (
            <div className="inline-flex rounded-md border border-border overflow-hidden">
              <button type="button" onClick={() => setScope("this-slug")} className={`px-2 py-1 ${scope === "this-slug" ? "bg-muted" : ""}`}>slug: {slug}</button>
              <button type="button" onClick={() => setScope("all")} className={`px-2 py-1 border-l border-border ${scope === "all" ? "bg-muted" : ""}`}>all</button>
            </div>
          )}
          <button type="button" onClick={() => setLive((v) => !v)} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 hover:bg-muted">
            {live ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Play className="h-3.5 w-3.5" /> Resume</>}
          </button>
          <button type="button" onClick={fetchNow} disabled={busy} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 hover:bg-muted disabled:opacity-50">
            <RefreshCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} /> Refresh
          </button>
        </div>
      </header>

      {error && (
        <div className="border-b border-border bg-red-500/10 px-4 py-2 text-xs text-red-800 dark:text-red-300">
          Failed to fetch repair history: {error}
        </div>
      )}

      {rows.length === 0 && !error ? (
        <div className="px-4 py-6 text-xs text-muted-foreground">
          No repair activity yet. Run any One-click Fix action or an Auto Deploy — tail/hint output from
          <span className="font-mono"> /usr/local/sbin/pluto-repair</span> and nginx reload will stream here in real time.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((e, i) => {
            const open = openIdx === i;
            const ok = e.ok === true || e.exitCode === 0;
            return (
              <li key={`${e.startedAt}-${i}`} className="px-4 py-2">
                <button type="button" onClick={() => setOpenIdx(open ? null : i)} className="flex w-full items-center gap-2 text-left">
                  <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`} />
                  <span className="text-xs font-mono">{e.action}</span>
                  {e.slug && <span className="text-xs text-muted-foreground">· {e.slug}</span>}
                  <span className="ml-auto text-xs text-muted-foreground">
                    exit {e.exitCode ?? "?"} · {e.durationMs ?? 0}ms · {e.startedAt ? new Date(e.startedAt).toLocaleTimeString() : ""}
                  </span>
                </button>
                {open && (
                  <div className="mt-2 space-y-2">
                    {e.hint && (
                      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                        <span className="font-medium">Hint:</span> {e.hint}
                      </div>
                    )}
                    <pre className="max-h-72 overflow-auto rounded-md border border-border bg-black/70 p-3 font-mono text-[11px] leading-relaxed text-green-100 whitespace-pre-wrap">
{e.tail || "(no output)"}
                    </pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
