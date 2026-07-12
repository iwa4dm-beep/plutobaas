import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CheckCircle2, XCircle, Circle, Trash2, ChevronDown, ChevronRight, History } from "lucide-react";
import { loadHistory, clearHistory, type HistoryEntry } from "@/lib/pluto/deploy-history";

export const Route = createFileRoute("/dashboard/deployment-history")({
  head: () => ({
    meta: [
      { title: "Deployment History — Pluto BaaS" },
      { name: "description", content: "Past VPS deploys with timestamps, status, and verification results." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: DeploymentHistoryPage,
});

function DeploymentHistoryPage() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const refresh = () => setEntries(loadHistory());
    refresh();
    window.addEventListener("pluto:deploy-history:changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("pluto:deploy-history:changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-10">
        <header className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
              <History className="h-7 w-7" /> Deployment History
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              সর্বশেষ ৫০টি deploy attempt — timestamp, status, verification result সহ। ডেটা এই browser-এ save থাকে।
            </p>
          </div>
          {entries.length > 0 && (
            <button
              onClick={() => { if (confirm("Clear all deployment history?")) clearHistory(); }}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-destructive/10 hover:text-destructive hover:border-destructive/40"
            >
              <Trash2 className="h-4 w-4" /> Clear all
            </button>
          )}
        </header>

        {entries.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            এখনও কোনো deploy attempt হয়নি। Auto-Connect Studio থেকে "Deploy to VPS" চালান।
          </div>
        )}

        <ol className="space-y-3">
          {entries.map((e) => {
            const open = expanded[e.id];
            const verify = e.steps.find((s) => s.key === "verify");
            const ts = new Date(e.timestamp);
            return (
              <li key={e.id} className="rounded-lg border border-border bg-card">
                <button
                  onClick={() => setExpanded((x) => ({ ...x, [e.id]: !x[e.id] }))}
                  className="w-full flex items-center gap-3 p-4 text-left hover:bg-accent/30"
                >
                  {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  {e.overallOk
                    ? <CheckCircle2 className="h-5 w-5 text-emerald-600" />
                    : <XCircle className="h-5 w-5 text-destructive" />}
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs text-muted-foreground">{ts.toLocaleString()}</div>
                    <div className="text-sm">
                      Workspace <span className="font-mono">{e.workspaceId}</span>
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground text-right">
                    {verify?.debug?.status ? (
                      <>verify HTTP {verify.debug.status} · {verify.debug.latencyMs}ms</>
                    ) : (
                      verify?.state ?? "—"
                    )}
                  </div>
                </button>
                {open && (
                  <div className="border-t border-border p-4 space-y-3">
                    {e.steps.map((s) => (
                      <div key={s.key} className="rounded-md border border-border/60 bg-muted/20 p-3">
                        <div className="flex items-center gap-2 text-sm">
                          {s.state === "ok" && <CheckCircle2 className="h-4 w-4 text-emerald-600" />}
                          {s.state === "error" && <XCircle className="h-4 w-4 text-destructive" />}
                          {s.state === "skipped" && <Circle className="h-4 w-4 text-muted-foreground" />}
                          <span className="font-medium">{s.label}</span>
                          {s.debug && (
                            <span className="ml-auto text-[11px] text-muted-foreground font-mono">
                              {s.debug.method} · HTTP {s.debug.status} · {s.debug.latencyMs}ms
                            </span>
                          )}
                        </div>
                        {s.detail && <div className="mt-1 text-[11px] text-muted-foreground font-mono break-all">{s.detail}</div>}
                        {s.debug && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-muted-foreground">Raw request/response</summary>
                            <div className="mt-2 space-y-2 text-[11px] font-mono">
                              <div className="text-muted-foreground break-all">
                                <span className="text-foreground font-semibold">{s.debug.method}</span> {s.debug.url}
                              </div>
                              {s.debug.reqBodyPreview && (
                                <div>
                                  <div className="text-muted-foreground">Request body:</div>
                                  <pre className="mt-1 whitespace-pre-wrap break-all bg-background/50 p-2 rounded">{s.debug.reqBodyPreview}</pre>
                                </div>
                              )}
                              <div>
                                <div className="text-muted-foreground">Response body:</div>
                                <pre className="mt-1 whitespace-pre-wrap break-all bg-background/50 p-2 rounded">{s.debug.resBodyPreview}</pre>
                              </div>
                            </div>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
