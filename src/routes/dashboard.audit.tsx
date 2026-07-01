import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Circle, Eye, RefreshCw, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { isLive, live, subscribe, type AuditEvent, type RealtimeEvent } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/audit")({
  component: AuditPage,
});

const ACTION_FILTERS = [
  { label: "All actions", value: "" },
  { label: "Migrations", value: "migration.*" },
  { label: "Job tokens", value: "job_token.*" },
];

const STATUS_ICON = {
  ok: <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />,
  error: <XCircle className="h-3.5 w-3.5 text-red-500" />,
  dry_run: <Eye className="h-3.5 w-3.5 text-sky-500" />,
} as const;

function AuditPage() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [filter, setFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [liveConn, setLiveConn] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      if (!isLive()) { setEvents(mockEvents); return; }
      setEvents(await live.audit.list({ action: filter || undefined, limit: 200 }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, [filter]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!isLive()) return;
    setLiveConn(true);
    const off = subscribe("system:audit", (e: RealtimeEvent) => {
      const p = e.payload as unknown as AuditEvent & { ts: string };
      if (!p) return;
      // Client-side action filter (server already filters on load).
      if (filter) {
        const prefix = filter.replace(/\*$/, "");
        if (!p.action.startsWith(prefix)) return;
      }
      setEvents((prev) => [{ ...p, id: p.id ?? Math.random().toString(36).slice(2) }, ...(prev ?? [])].slice(0, 200));
    });
    return () => { off(); setLiveConn(false); };
  }, [filter]);

  return (
    <div>
      <PageHeader
        title="Audit trail"
        description="Every privileged dashboard action: migration runs, rollbacks, and job-token mint / revoke, streamed live."
      />

      <div className="flex items-center gap-3 mb-4">
        <select value={filter} onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-1.5 text-sm">
          {ACTION_FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <button onClick={() => void load()} className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
          <RefreshCw className="h-3.5 w-3.5" /> Refresh
        </button>
        {isLive() && (
          <span className="text-xs inline-flex items-center gap-1.5">
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
            {(events ?? []).map((e) => (
              <tr key={e.id} className="border-t border-border align-top">
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{new Date(e.ts).toLocaleString()}</td>
                <td className="px-3 py-2">
                  <div className="inline-flex items-center gap-1.5 text-xs">
                    {STATUS_ICON[e.status] ?? <Circle className="h-3.5 w-3.5" />}
                    <code>{e.action}</code>
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">
                  <div>{e.actor_email ?? <span className="text-muted-foreground">—</span>}</div>
                  <div className="text-muted-foreground">{e.actor_role ?? ""}{e.ip ? ` · ${e.ip}` : ""}</div>
                </td>
                <td className="px-3 py-2 text-xs font-mono">{e.target ?? "—"}</td>
                <td className="px-3 py-2 text-xs">
                  {e.metadata && Object.keys(e.metadata).length > 0 ? (
                    <pre className="bg-muted/40 rounded p-1.5 text-[11px] whitespace-pre-wrap max-w-md">{JSON.stringify(e.metadata, null, 0)}</pre>
                  ) : <span className="text-muted-foreground">—</span>}
                </td>
              </tr>
            ))}
            {events && events.length === 0 && (
              <tr><td className="px-3 py-6 text-center text-xs text-muted-foreground" colSpan={5}>No events yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const mockEvents: AuditEvent[] = [
  { id: "1", ts: new Date().toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "ok", metadata: { applied: ["0004_phase6"], failed: [] }, ip: "127.0.0.1" },
  { id: "2", ts: new Date(Date.now() - 60_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "job_token.mint", target: "t_abc", status: "ok", metadata: { name: "nightly-rollup", scope: ["rollup_invoices"] }, ip: "127.0.0.1" },
  { id: "3", ts: new Date(Date.now() - 300_000).toISOString(), actor_id: "u_admin", actor_email: "admin@pluto.local", actor_role: "admin", action: "migration.run", target: null, status: "dry_run", metadata: { versions: ["0005_audit"], count: 1 }, ip: "127.0.0.1" },
];
