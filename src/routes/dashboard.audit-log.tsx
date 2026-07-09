import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { live, isLive, type AuditEvent, type AuditQuery } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, RefreshCw, ChevronDown, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/audit-log")({ component: AuditLogPage });

// Curated filter chips that map to `action LIKE prefix%` on the backend.
const CHIPS = [
  { label: "All",                prefix: "" },
  { label: "Backup restore",     prefix: "backup.restore" },
  { label: "Backup export",      prefix: "backup.export" },
  { label: "Quotas",             prefix: "quota" },
  { label: "Functions",          prefix: "function" },
  { label: "Tokens",             prefix: "tokens" },
  { label: "Webhooks",           prefix: "webhook" },
  { label: "Schema",             prefix: "schema" },
] as const;

function AuditLogPage() {
  const [chip, setChip] = useState<string>("");
  const [actor, setActor] = useState("");
  const [status, setStatus] = useState<AuditQuery["status"] | "">("");
  const [items, setItems] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const limit = 50;

  const load = useCallback(async () => {
    if (!isLive()) return;
    setLoading(true);
    try {
      const r = await live.audit.list({
        action: chip ? `${chip}*` : undefined,
        actor: actor || undefined,
        status: status || undefined,
        limit, offset,
      });
      setItems(r.items); setTotal(r.total);
    } catch (e) { toast.error((e as Error).message); }
    finally { setLoading(false); }
  }, [chip, actor, status, offset]);

  useEffect(() => { void load(); }, [load]);

  const pages = useMemo(() => Math.max(1, Math.ceil(total / limit)), [total]);
  const page = Math.floor(offset / limit) + 1;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><ShieldAlert className="h-5 w-5" /> Audit Log</h1>
      <AutoHelpPanel slug={'dashboard.audit-log'} title={'Audit Log'} description={''} />
          <p className="text-sm text-muted-foreground">Restore runs, quota edits, function changes, tokens, and webhooks — with actor, timing, and dry-run vs confirmed outcomes.</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => { setOffset(0); void load(); }}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {!isLive() && (
        <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-xs">
          Set <code>VITE_PLUTO_URL</code> to a running Pluto instance to browse audit events.
        </div>
      )}

      <Card>
        <CardHeader><CardTitle className="text-sm">Filters</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {CHIPS.map(c => {
              const on = c.prefix === chip;
              return (
                <button key={c.label} onClick={() => { setChip(c.prefix); setOffset(0); }}
                        className={"text-[11px] px-2 py-1 rounded border " +
                          (on ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-accent")}>
                  {c.label}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2 flex-wrap">
            <Input placeholder="actor email contains…" value={actor}
                   onChange={e => setActor(e.target.value)}
                   onKeyDown={e => { if (e.key === "Enter") { setOffset(0); void load(); } }}
                   className="max-w-xs" />
            <select value={status} onChange={e => { setStatus(e.target.value as AuditQuery["status"] | ""); setOffset(0); }}
                    className="h-9 px-2 rounded-md border border-border bg-background text-sm">
              <option value="">any status</option>
              <option value="ok">ok</option>
              <option value="dry_run">dry_run</option>
              <option value="error">error</option>
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center justify-between">
            <span>{total.toLocaleString()} events</span>
            <span className="text-xs text-muted-foreground">
              page {page} / {pages}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-1">
            {items.map(ev => {
              const open = !!expanded[ev.id];
              const dry = ev.status === "dry_run";
              return (
                <div key={ev.id} className="border border-border rounded-md">
                  <button onClick={() => setExpanded(m => ({ ...m, [ev.id]: !open }))}
                          className="w-full grid grid-cols-[16px,180px,120px,1fr,80px,180px] gap-2 items-center text-xs p-2 text-left">
                    {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span className="text-muted-foreground">{new Date(ev.ts).toLocaleString()}</span>
                    <span className="font-mono truncate">{ev.action}</span>
                    <span className="truncate text-muted-foreground">{ev.target ?? "—"}</span>
                    <Badge variant={ev.status === "error" ? "destructive" : dry ? "secondary" : "default"}>
                      {ev.status}
                    </Badge>
                    <span className="truncate text-muted-foreground text-right">
                      {ev.actor_email ?? ev.actor_id ?? "system"}{ev.actor_role ? ` · ${ev.actor_role}` : ""}
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-border p-2 text-[11px] space-y-1">
                      <div className="flex gap-4 text-muted-foreground">
                        <span>ip: {ev.ip ?? "—"}</span>
                        <span>id: <span className="font-mono">{ev.id}</span></span>
                      </div>
                      <pre className="font-mono text-[10px] p-2 rounded bg-muted overflow-x-auto max-h-[240px]">{JSON.stringify(ev.metadata, null, 2)}</pre>
                    </div>
                  )}
                </div>
              );
            })}
            {items.length === 0 && !loading && (
              <div className="text-xs text-muted-foreground py-4 text-center">No matching audit events.</div>
            )}
          </div>
          <div className="flex justify-between items-center mt-3 text-xs">
            <Button size="sm" variant="outline" disabled={offset === 0 || loading}
                    onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
            <span className="text-muted-foreground">{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            <Button size="sm" variant="outline" disabled={offset + limit >= total || loading}
                    onClick={() => setOffset(offset + limit)}>Next</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
