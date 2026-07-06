import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronLeft, ChevronRight, Circle, Eye, RefreshCw, Search, ShieldAlert, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import {
  isLive, live, subscribe,
  type AuditEvent, type AuditPage, type AuditQuery,
  type RealtimeAuthError, type RealtimeEvent, type RealtimeStatus,
} from "@/lib/pluto/live";

// Small debounce hook — audit filter inputs use it so we don't refetch
// (and re-run the ILIKE query on the server) on every keystroke. The
// server still enforces its own limits via zod max lengths.
function useDebounced<T>(value: T, ms = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}


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
  const [pageData, setPageData] = useState<AuditPage | null>(null);
  // Raw inputs (change on every keystroke) …
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [actorId, setActorId] = useState("");
  const [status, setStatus] = useState<"" | "ok" | "error" | "dry_run">("");
  const [text, setText] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  // … debounced values feed the actual fetch. Fast typing does NOT
  // trigger a burst of /admin/v1/audit calls.
  const dActor       = useDebounced(actor);
  const dActorId     = useDebounced(actorId);
  const dText        = useDebounced(text);
  const dWorkspaceId = useDebounced(workspaceId);
  const [offset, setOffset] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [liveConn, setLiveConn] = useState(false);
  const [authErr, setAuthErr] = useState<{ code: RealtimeAuthError; message: string } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) {
        setPageData({ items: [], total: 0, limit: PAGE_SIZE, offset: 0, next_offset: null });
        setErr("Backend not configured.");
        return;
      }
      const q: AuditQuery = { limit: PAGE_SIZE, offset };
      if (action) q.action = action;
      if (dActor) q.actor = dActor;
      if (dActorId) q.actor_id = dActorId;
      if (status) q.status = status;
      if (dText) q.q = dText;
      if (dWorkspaceId) q.workspace_id = dWorkspaceId;
      setPageData(await live.audit.list(q));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [action, dActor, dActorId, status, dText, dWorkspaceId, offset]);

  useEffect(() => { void load(); }, [load]);

  // Reset to first page when any filter changes.
  useEffect(() => { setOffset(0); }, [action, dActor, dActorId, status, dText, dWorkspaceId]);

  useEffect(() => {
    if (!isLive()) return;
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
      if (dActor && !(p.actor_email ?? "").toLowerCase().includes(dActor.toLowerCase())) return;
      if (dActorId && p.actor_id !== dActorId) return;
      if (dWorkspaceId) {
        const md = (p.metadata ?? {}) as { workspace_id?: string };
        if (md.workspace_id !== dWorkspaceId) return;
      }
      if (dText) {
        const t = dText.toLowerCase();
        const hit = p.action.toLowerCase().includes(t)
                 || (p.target ?? "").toLowerCase().includes(t)
                 || (p.actor_email ?? "").toLowerCase().includes(t);
        if (!hit) return;
      }
      setPageData((prev) => prev ? {
        ...prev,
        items: [{ ...p, id: p.id ?? Math.random().toString(36).slice(2) }, ...prev.items].slice(0, PAGE_SIZE),
        total: prev.total + 1,
      } : prev);
    }, {
      onStatus: (s: RealtimeStatus) => {
        if (s.kind === "open") { setLiveConn(true); setAuthErr(null); }
        else if (s.kind === "auth_error") { setLiveConn(false); setAuthErr({ code: s.error, message: s.message }); }
        else setLiveConn(false);
      },
    });
    return () => { off(); setLiveConn(false); };
  }, [action, dActor, dActorId, status, dText, dWorkspaceId, offset]);

  const items = pageData?.items ?? [];
  const total = pageData?.total ?? 0;
  const pageIdx = Math.floor(offset / PAGE_SIZE) + 1;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Silence unused-var warning if downstream doesn't use it.
  useMemo(() => pageCount, [pageCount]);


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

      {authErr && (
        <div className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500 flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-semibold">Realtime paused — {authErr.code}</div>
            <div className="text-amber-500/80 mt-0.5">{authErr.message} Reconnect attempts have stopped until you refresh with valid credentials.</div>
          </div>
        </div>
      )}
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
            {pageData && items.length === 0 && (
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
            disabled={!pageData?.next_offset}
            className="inline-flex items-center gap-1 rounded-md border border-input px-2 py-1 hover:bg-accent disabled:opacity-40"
          >Next <ChevronRight className="h-3 w-3" /></button>
        </div>
      </div>
    </div>
  );
}

// Storage-aware detail renderer. Extracts common fields
// (bucket / key / grant / upload / workspace / part / size / mime)
// from event metadata and renders them as chips instead of a raw JSON
// blob. Falls back to a compact JSON pre for unknown shapes.
function AuditDetails({ ev, onFilterWorkspace }: {
  ev: AuditEvent;
  onFilterWorkspace: (id: string) => void;
}) {
  const md = (ev.metadata ?? {}) as Record<string, unknown>;
  if (!md || Object.keys(md).length === 0) return <span className="text-muted-foreground">—</span>;

  const isStorage = ev.action.startsWith("storage.");
  const str = (v: unknown) => typeof v === "string" ? v : undefined;
  const num = (v: unknown) => typeof v === "number" ? v : undefined;

  // Storage action classifier — verb after "storage."
  // e.g. "storage.upload.complete" → "upload.complete"
  const storageKind = isStorage ? ev.action.slice("storage.".length) : null;

  const bucket    = str(md.bucket);
  const objectKey = str(md.key) ?? str(md.object_key) ?? str(md.path);
  const grantId   = str(md.grant_id) ?? str(md.signed_grant_id) ?? str(md.token_id);
  const uploadId  = str(md.upload_id);
  const partNo    = num(md.part_number) ?? num(md.part);
  const size      = num(md.size) ?? num(md.content_length);
  const mime      = str(md.content_type) ?? str(md.mime);
  const oneTime   = md.one_time === true;
  const expiresIn = num(md.expires_in);
  const wsId      = str(md.workspace_id);
  const err       = str(md.error);

  const chips: { label: string; value: string; mono?: boolean; onClick?: () => void; title?: string }[] = [];
  if (isStorage && storageKind) chips.push({ label: "op", value: storageKind });
  if (bucket)    chips.push({ label: "bucket", value: bucket, mono: true });
  if (objectKey) chips.push({ label: "key",    value: objectKey, mono: true });
  if (grantId)   chips.push({ label: "grant",  value: grantId, mono: true, title: grantId });
  if (uploadId)  chips.push({ label: "upload", value: uploadId, mono: true, title: uploadId });
  if (partNo != null) chips.push({ label: "part", value: `#${partNo}` });
  if (size != null)   chips.push({ label: "size", value: formatBytes(size) });
  if (mime)     chips.push({ label: "mime", value: mime });
  if (oneTime)  chips.push({ label: "one-time", value: "yes" });
  if (expiresIn != null) chips.push({ label: "ttl", value: `${expiresIn}s` });
  if (wsId) chips.push({
    label: "workspace", value: `${wsId.slice(0, 8)}…`, mono: true,
    title: wsId, onClick: () => onFilterWorkspace(wsId),
  });

  // Known-key set we already surfaced as chips — remaining go into "extras".
  const consumed = new Set([
    "bucket", "key", "object_key", "path", "grant_id", "signed_grant_id",
    "token_id", "upload_id", "part_number", "part", "size", "content_length",
    "content_type", "mime", "one_time", "expires_in", "workspace_id", "error",
  ]);
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(md)) if (!consumed.has(k)) extras[k] = v;

  return (
    <div className="space-y-1 max-w-md">
      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chips.map((c, i) => (
            <button
              key={i}
              type="button"
              onClick={c.onClick}
              disabled={!c.onClick}
              title={c.title ?? (c.onClick ? "Click to filter" : undefined)}
              className={`inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] leading-none ${c.onClick ? "hover:bg-accent cursor-pointer" : "cursor-default"}`}
            >
              <span className="text-muted-foreground">{c.label}</span>
              <span className={c.mono ? "font-mono" : ""}>{c.value}</span>
            </button>
          ))}
        </div>
      )}
      {err && (
        <div className="text-[11px] text-red-500 break-words">error: {err}</div>
      )}
      {Object.keys(extras).length > 0 && (
        <pre className="bg-muted/40 rounded p-1.5 text-[11px] whitespace-pre-wrap break-all">
          {JSON.stringify(extras, null, 0)}
        </pre>
      )}
    </div>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const mockEvents: AuditEvent[] = [
  { id: "1", ts: new Date().toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "ok", metadata: { applied: ["0004_phase6"], failed: [] }, ip: "127.0.0.1" },
  { id: "2", ts: new Date(Date.now() - 60_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "job_token.mint", target: "t_abc", status: "ok", metadata: { name: "nightly-rollup", scope: ["rollup_invoices"] }, ip: "127.0.0.1" },
  { id: "3", ts: new Date(Date.now() - 300_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "dry_run", metadata: { versions: ["0005_audit"], count: 1 }, ip: "127.0.0.1" },
];
