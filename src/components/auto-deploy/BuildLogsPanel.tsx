// Build Logs — structured, filterable log viewer for the current deploy.
// Sources every attempt across every step and renders a virtualized list with
// per-step collapsers, level filter, copy, and .log download.
import { useMemo, useState } from "react";
import { ScrollText, Copy, Download, ChevronDown, ChevronRight, Filter } from "lucide-react";
import type { DeployAllResult, DeployStepLog, DeployStepAttempt } from "@/lib/pluto/vps-deployer.functions";

type Level = "info" | "warn" | "error";
type LogRow = {
  id: string;
  stepKey: string;
  stepLabel: string;
  attempt: number;
  level: Level;
  ts: string;
  latencyMs: number;
  method: string | null;
  url: string | null;
  status: number | null;
  detail: string;
  body: string | null;
};

function levelOf(a: DeployStepAttempt): Level {
  if (a.ok) return "info";
  const status = a.debug?.status ?? 0;
  if (status >= 500 || status === 0) return "error";
  return "warn";
}

function flatten(result: DeployAllResult): LogRow[] {
  const rows: LogRow[] = [];
  for (const step of result.steps) {
    for (const a of step.attempts) {
      rows.push({
        id: `${step.key}-${a.attempt}`,
        stepKey: step.key,
        stepLabel: step.label,
        attempt: a.attempt,
        level: levelOf(a),
        ts: a.startedAt,
        latencyMs: a.latencyMs,
        method: a.debug?.method ?? null,
        url: a.debug?.url ?? null,
        status: a.debug?.status ?? null,
        detail: a.detail,
        body: (a.debug as { body?: string } | null)?.body ?? null,
      });
    }
  }
  return rows;
}

function rowToLine(r: LogRow): string {
  const parts = [
    r.ts,
    r.level.toUpperCase(),
    `[${r.stepKey}#${r.attempt}]`,
    r.method && r.url ? `${r.method} ${r.url}` : "",
    r.status != null ? `→ ${r.status}` : "",
    `(${r.latencyMs}ms)`,
    "—",
    r.detail.replace(/\s+/g, " ").slice(0, 400),
  ];
  return parts.filter(Boolean).join(" ");
}

function download(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const levelDot: Record<Level, string> = {
  info: "bg-emerald-500",
  warn: "bg-amber-500",
  error: "bg-destructive",
};

export function BuildLogsPanel({ result }: { result: DeployAllResult }) {
  const rows = useMemo(() => flatten(result), [result]);
  const [levelFilter, setLevelFilter] = useState<Record<Level, boolean>>({ info: true, warn: true, error: true });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedRow, setExpandedRow] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (!levelFilter[r.level]) return false;
      if (!q) return true;
      return (
        r.detail.toLowerCase().includes(q) ||
        r.stepKey.toLowerCase().includes(q) ||
        (r.url?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, levelFilter, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; items: LogRow[] }>();
    for (const r of filtered) {
      const g = map.get(r.stepKey) ?? { label: r.stepLabel, items: [] };
      g.items.push(r);
      map.set(r.stepKey, g);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const counts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0, total: rows.length };
    for (const r of rows) c[r.level]++;
    return c;
  }, [rows]);

  function copyAll() {
    const text = filtered.map(rowToLine).join("\n");
    void navigator.clipboard?.writeText(text);
  }

  function exportLog() {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const text = filtered.map(rowToLine).join("\n") + "\n";
    download(`auto-deploy-${result.workspaceId?.slice(0, 8) ?? "log"}-${stamp}.log`, text);
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 flex items-center justify-between gap-2">
        <div className="text-sm font-medium flex items-center gap-2">
          <ScrollText className="h-4 w-4" /> Build logs
          <span className="text-xs font-normal text-muted-foreground">
            {filtered.length} / {counts.total} · {counts.error} error · {counts.warn} warn · {counts.info} info
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copyAll}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Copy className="h-3 w-3" /> Copy
          </button>
          <button
            onClick={exportLog}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <Download className="h-3 w-3" /> .log
          </button>
        </div>
      </div>

      <div className="border-b border-border px-4 py-2 flex flex-wrap items-center gap-2">
        <Filter className="h-3.5 w-3.5 text-muted-foreground" />
        {(["info", "warn", "error"] as Level[]).map((lvl) => (
          <label key={lvl} className="inline-flex items-center gap-1 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={levelFilter[lvl]}
              onChange={(e) => setLevelFilter((f) => ({ ...f, [lvl]: e.target.checked }))}
              className="h-3 w-3"
            />
            <span className={`inline-block h-2 w-2 rounded-full ${levelDot[lvl]}`} />
            {lvl}
          </label>
        ))}
        <input
          type="text"
          placeholder="filter by url, step or message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="ml-auto w-56 rounded-md border border-border bg-background px-2 py-1 text-xs outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="max-h-[480px] overflow-auto">
        {grouped.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No log rows match the current filters.</div>
        ) : (
          grouped.map(([stepKey, group]) => {
            const isCollapsed = collapsed[stepKey];
            const errCount = group.items.filter((r) => r.level === "error").length;
            return (
              <div key={stepKey} className="border-b border-border last:border-b-0">
                <button
                  onClick={() => setCollapsed((c) => ({ ...c, [stepKey]: !c[stepKey] }))}
                  className="w-full flex items-center gap-2 px-4 py-2 text-xs font-medium bg-muted/30 hover:bg-muted"
                >
                  {isCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  <span className="font-mono">{stepKey}</span>
                  <span className="text-muted-foreground">— {group.label}</span>
                  <span className="ml-auto text-muted-foreground">
                    {group.items.length} rows{errCount > 0 ? ` · ${errCount} err` : ""}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul className="divide-y divide-border/60 font-mono">
                    {group.items.map((r) => {
                      const open = !!expandedRow[r.id];
                      return (
                        <li key={r.id} className="text-[11px]">
                          <button
                            onClick={() => setExpandedRow((e) => ({ ...e, [r.id]: !e[r.id] }))}
                            className="w-full flex items-start gap-2 px-4 py-1.5 text-left hover:bg-muted/40"
                          >
                            <span className={`mt-1 inline-block h-1.5 w-1.5 rounded-full ${levelDot[r.level]}`} />
                            <span className="text-muted-foreground shrink-0">{r.ts.slice(11, 19)}</span>
                            <span className="text-muted-foreground shrink-0">#{r.attempt}</span>
                            {r.method && (
                              <span className="shrink-0 text-primary">{r.method}</span>
                            )}
                            {r.status != null && (
                              <span className={`shrink-0 ${r.status >= 400 || r.status === 0 ? "text-destructive" : "text-emerald-600"}`}>
                                {r.status || "ERR"}
                              </span>
                            )}
                            <span className="shrink-0 text-muted-foreground">{r.latencyMs}ms</span>
                            <span className="truncate flex-1">{r.url ?? r.detail}</span>
                          </button>
                          {open && (
                            <div className="px-4 pb-2 pt-1 space-y-1 bg-muted/20">
                              {r.url && (
                                <div className="text-muted-foreground break-all">
                                  <span className="text-foreground/70">url:</span> {r.url}
                                </div>
                              )}
                              <div className="text-muted-foreground whitespace-pre-wrap break-words">
                                <span className="text-foreground/70">detail:</span> {r.detail || "—"}
                              </div>
                              {r.body && (
                                <pre className="whitespace-pre-wrap break-words rounded bg-background border border-border p-2 max-h-56 overflow-auto">
                                  {r.body.slice(0, 4000)}
                                </pre>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
