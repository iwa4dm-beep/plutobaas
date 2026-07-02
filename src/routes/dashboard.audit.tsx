import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Eye, RefreshCw, Search, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, subscribe, type AuditEvent, type AuditPage, type AuditQuery, type RealtimeEvent } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/audit")({
  component: AuditPage,
});

const ACTION_PRESETS = [
  { label: "All actions",   value: "" },
  { label: "Migrations",    value: "migration.*" },
  { label: "Job tokens",    value: "job_token.*" },
  { label: "SQL runner",    value: "sql.*" },
  { label: "Storage",       value: "storage.*" },
  { label: "Signed URLs",   value: "storage.sign*" },
  { label: "Auth",          value: "auth.*" },
  { label: "API keys",      value: "api_key.*" },
];

const STATUS_ICON = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  dry_run: <Eye className="h-3.5 w-3.5 text-sky-500" />,
} as const;

const PAGE_SIZE = 50;

function AuditPage() {
  const [page, setPage] = useState<AuditPage | null>(null);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [actorId, setActorId] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "error" | "dry_run">("");
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [liveConn, setLiveConn] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) {
        setPage({ items: mockEvents, total: mockEvents.length, limit: PAGE_SIZE, offset: 0, next_offset: null });
        return;
      }
      const q: AuditQuery = { limit: PAGE_SIZE, offset };
      if (action) q.action = action;
      if (actor) q.actor = actor;
      if (actorId) q.actor_id = actorId;
      if (status) q.status = status;
      if (text) q.q = text;
      if (workspaceId) q.workspace_id = workspaceId;
      setPage(await live.audit.list(q));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [action, actor, actorId, status, text, workspaceId, offset]);

  useEffect(() => { void load(); }, [load]);

  // Reset to first page when any filter changes.
  useEffect(() => { setOffset(0); }, [action, actor, actorId, status, text, workspaceId]);

  useEffect(() => {
    if (!isLive()) return;
    setLiveConn(true);
    const off = subscribe("system:audit", (e: RealtimeEvent) => {
      const p = e.payload as unknown as AuditEvent & { ts: string };
      if (!p) return;
      // Only prepend live events when viewing the first page with no filters that would exclude them.
      if (offset !== 0) return;
      if (action) {
        const prefix = action.replace(/\*$/, "");
        if (!p.action.startsWith(prefix)) return;
      }
      if (status && p.status !== status) return;
      if (actor && !(p.actor_email ?? "").toLowerCase().includes(actor.toLowerCase())) return;
      if (actorId && p.actor_id !== actorId) return;
      if (workspaceId) {
        const md = (p.metadata ?? {}) as { workspace_id?: string };
        if (md.workspace_id !== workspaceId) return;
      }
      if (text) {
        const t = text.toLowerCase();
        const hit = p.action.toLowerCase().includes(t)
                 || (p.target ?? "").toLowerCase().includes(t)
                 || (p.actor_email ?? "").toLowerCase().includes(t);
        if (!hit) return;
      }
      setPage((prev) => prev ? {
        ...prev,
        items: [{ ...p, id: p.id ?? Math.random().toString(36).slice(2) }, ...prev.items].slice(0, PAGE_SIZE),
        total: prev.total + 1,
      } : prev);
    });
    return () => { off(); setLiveConn(false); };
  }, [action, actor, actorId, status, text, workspaceId, offset]);

  const items = page?.items ?? [];
  const total = page?.total ?? 0;
  const pageIdx = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <PageHeader
        title="Audit trail"
        description="Every privileged dashboard action — migration runs, rollbacks, storage grants, and SQL runner executions — filterable by workspace, actor, or event class and streamed live."
      />

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <select value={action} onChange={(e) => setAction(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm">
          {ACTION_PRESETS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm">
          <option value="">Any status</option>
          <option value="ok">ok</option>
          <option value="error">error</option>
          <option value="dry_run">dry_run</option>
        </select>
        <input value={actor} onChange={(e) => setActor(e.target.value)} placeholder="User email…"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-44" />
        <input value={actorId} onChange={(e) => setActorId(e.target.value.trim())} placeholder="User ID (UUID)…"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-56 font-mono" />
        <input value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value.trim())}
          placeholder="Workspace UUID…"
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-64 font-mono" />
        <div className="relative">
          <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Search action / target…"
            className="rounded-md border border-input bg-background pl-7 pr-3 py-1.5 text-sm w-64" />
        </div>
        <button onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        {isLive() && (
          <span className="text-xs inline-flex items-center gap-1.5 ml-auto">
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${liveConn ? "bg-emerald-500 animate-pulse" : "bg-muted-foreground"}`} />
            <span className={liveConn ? "text-emerald-500" : "text-muted-foreground"}>{liveConn ? "live" : "connecting…"}</span>
          </span>
        )}
      </div>

      {err && <div className="mb-3 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-500">{err}</div>}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium w-40">When</th>
              <th className="text-left px-3 py-2 font-medium">Action</th>
              <th className="text-left px-3 py-2 font-medium">Actor</th>
              <th className="text-left px-3 py-2 font-medium">Target</th>
              <th className="text-left px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(e.ts).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <div className="inline-flex items-center gap-1.5 text-xs">
                    {STATUS_ICON[e.status] ?? <Circle className="h-3.5 w-3.5" />}
                    <code>{e.action}</code>
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>
                    {e.actor_email ?? <span className="text-muted-foreground">—</span>}
                    {e.actor_id && (
                      <button
                        type="button"
                        onClick={() => setActorId(e.actor_id ?? "")}
                        title="Filter by this user"
                        className="ml-1 text-[10px] text-muted-foreground hover:text-foreground underline decoration-dotted"
                      >filter</button>
                    )}
                  </div>
                  <div className="text-muted-foreground">
                    {e.actor_role ?? ""}
                    {e.actor_id ? ` · ${e.actor_id.slice(0, 8)}…` : ""}
                    {e.ip ? ` · ${e.ip}` : ""}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs font-mono">{e.target ?? "—"}</td>
                <td className="px-3 py-2 text-xs">
                  <AuditDetails ev={e} onFilterWorkspace={setWorkspaceId} />
                </td>
              </tr>
            ))}
            {page && items.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground" colSpan={5}>No events match these filters.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
        <div>{total.toLocaleString()} event{total === 1 ? "" : "s"} · page {pageIdx} / {pageCount}</div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            disabled={offset === 0}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-40"
          ><ChevronLeft className="h-3 w-3" /> Prev</button>
          <button
            onClick={() => setOffset(offset + PAGE_SIZE)}
            disabled={!page?.next_offset}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-40"
          >Next <ChevronRight className="h-3 w-3" /></button>
        </div>
      </div>
    </div>
  );
}

const mockEvents: AuditEvent[] = [
  { id: "1", ts: new Date().toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "ok", metadata: { applied: ["0004_phase6"], failed: [] }, ip: "127.0.0.1" },
  { id: "2", ts: new Date(Date.now() - 60_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "job_token.mint", target: "t_abc", status: "ok", metadata: { name: "nightly-rollup", scope: ["rollup_invoices"] }, ip: "127.0.0.1" },
  { id: "3", ts: new Date(Date.now() - 300_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "dry_run", metadata: { versions: ["0005_audit"], count: 1 }, ip: "127.0.0.1" },
];
