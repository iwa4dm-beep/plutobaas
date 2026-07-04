import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { rt2, cdc, isLive, type Rt2Channel, type Rt2Message, type Rt2Member, type CdcTable } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Radio, Users2, Send, Plus, RefreshCw, Database, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PresenceIndicator, type PresenceStatus } from "@/components/pluto/PresenceIndicator";
import { PaginatedTable } from "@/components/pluto/PaginatedTable";
import { usePaginatedTable } from "@/lib/pluto/usePaginatedTable";

export const Route = createFileRoute("/dashboard/realtime")({ component: RealtimePage });

function RealtimePage() {
  const [channels, setChannels] = useState<Rt2Channel[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<Rt2Message[]>([]);
  const [members, setMembers] = useState<Rt2Member[]>([]);
  const [newName, setNewName] = useState("");
  const [event, setEvent] = useState("update");
  const [payload, setPayload] = useState('{"hello":"world"}');
  const [memberKey, setMemberKey] = useState("user-" + Math.floor(Math.random()*1000));
  const [presenceStatus, setPresenceStatus] = useState<PresenceStatus>("idle");
  const [presenceAttempt, setPresenceAttempt] = useState(0);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);
  const presenceStopRef = useRef<null | (() => void)>(null);

  async function refresh() {
    if (!isLive()) return;
    try { const r = await rt2.channels(); setChannels(r.channels); if (!active && r.channels[0]) setActive(r.channels[0].name); }
    catch (e) { toast.error((e as Error).message); }
  }
  // Messages still poll (broadcast history); presence uses the hardened subscription.
  async function refreshMessages(name: string) {
    try { const m = await rt2.messages(name, 50); setMessages(m.messages); }
    catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!active) return;
    refreshMessages(active);
    const t = setInterval(() => refreshMessages(active), 3000);
    return () => clearInterval(t);
  }, [active]);

  // Tear down presence subscription when switching channels or unmounting.
  useEffect(() => () => { presenceStopRef.current?.(); presenceStopRef.current = null; }, []);
  useEffect(() => {
    presenceStopRef.current?.(); presenceStopRef.current = null;
    setJoined(false); setPresenceStatus("idle"); setMembers([]); setPresenceError(null); setPresenceAttempt(0);
  }, [active]);

  async function createChannel() {
    if (!newName.trim()) return;
    try { await rt2.createChannel(newName.trim(), "broadcast"); setNewName(""); toast.success("Channel created"); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function send() {
    if (!active) return;
    try { const parsed = JSON.parse(payload); await rt2.broadcast(active, event, parsed, memberKey); await refreshMessages(active); }
    catch (e) { toast.error((e as Error).message); }
  }
  function join() {
    if (!active || joined) return;
    setJoined(true);
    presenceStopRef.current = rt2.subscribePresence(active, memberKey, {
      metadata: { joinedAt: new Date().toISOString() },
      onMembers: (m) => setMembers(m),
      onError:   (e) => setPresenceError(e.message),
      onReconnect: (n) => toast.info(`Presence reconnected (attempt ${n})`),
      onStatus:  (s, n, err) => {
        setPresenceStatus(s); setPresenceAttempt(n);
        if (err) setPresenceError(err.message);
        if (s === "live") setPresenceError(null);
        if (s === "failed") toast.error("Presence disconnected after retries — click Join to try again.");
      },
    });
  }
  function leave() {
    presenceStopRef.current?.(); presenceStopRef.current = null;
    setJoined(false); setPresenceStatus("idle"); setMembers([]);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Radio className="h-5 w-5" /> Realtime channels</h1>
          <p className="text-sm text-muted-foreground">Broadcast events and track presence per channel.</p>
        </div>
        <div className="flex items-center gap-2">
          <PresenceIndicator status={presenceStatus} attempt={presenceAttempt} channel={active ?? undefined} lastError={presenceError} />
          <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px,1fr]">
        <Card>
          <CardHeader><CardTitle className="text-sm">Channels</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Input placeholder="new channel" value={newName} onChange={e => setNewName(e.target.value)} />
              <Button size="sm" onClick={createChannel}><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="space-y-1">
              {channels.map(c => (
                <button key={c.id} onClick={() => setActive(c.name)}
                  className={"w-full text-left px-3 py-2 rounded-md text-sm flex items-center justify-between " +
                    (active === c.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}>
                  <span>{c.name}</span>
                  <Badge variant="secondary">{c.members ?? 0}</Badge>
                </button>
              ))}
              {channels.length === 0 && <div className="text-xs text-muted-foreground p-2">No channels yet.</div>}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Send className="h-4 w-4" /> Broadcast</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-2">
                <Input placeholder="event" value={event} onChange={e => setEvent(e.target.value)} />
                <Input placeholder="sender" value={memberKey} onChange={e => setMemberKey(e.target.value)} />
                <div className="flex gap-2">
                  {joined
                    ? <Button size="sm" variant="outline" onClick={leave}>Leave</Button>
                    : <Button size="sm" variant="outline" onClick={join} disabled={!active}>Join</Button>}
                  <Button size="sm" onClick={send} disabled={!active}>Send</Button>
                </div>
              </div>
              <textarea className="w-full min-h-[80px] font-mono text-xs p-2 rounded-md border border-border bg-background"
                        value={payload} onChange={e => setPayload(e.target.value)} />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Users2 className="h-4 w-4" /> Presence ({members.length})</CardTitle></CardHeader>
              <CardContent className="space-y-1 max-h-[400px] overflow-y-auto">
                {members.map(m => (
                  <div key={m.member_key} className="text-xs p-2 rounded-md border border-border">
                    <div className="font-medium">{m.member_key}</div>
                    <div className="text-muted-foreground">{new Date(m.last_seen).toLocaleTimeString()}</div>
                  </div>
                ))}
                {members.length === 0 && <div className="text-xs text-muted-foreground">No active members.</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Recent messages</CardTitle></CardHeader>
              <CardContent>
                <MessagesTable messages={messages} />
              </CardContent>
            </Card>
          </div>

          <CdcPanel />
        </div>
      </div>
    </div>
  );
}

function MessagesTable({ messages }: { messages: Rt2Message[] }) {
  const t = usePaginatedTable(messages, { pageSize: 15, defaultSort: { key: "created_at", dir: "desc" } });
  return (
    <PaginatedTable
      rows={t.rows} sorted={t.sorted}
      page={t.page} pageSize={t.pageSize} totalPages={t.totalPages}
      sortKey={t.sortKey} sortDir={t.sortDir}
      onPage={t.setPage} onSort={t.toggleSort}
      csvFilename="realtime-messages.csv"
      csvColumns={["created_at","event","sender","payload"]}
      columns={[
        { key: "event", label: "event", className: "w-24" },
        { key: "sender", label: "sender", className: "w-32",
          render: (r) => <span className="text-muted-foreground">{r.sender ?? "—"}</span> },
        { key: "payload", label: "payload",
          render: (r) => <pre className="text-[10px] font-mono truncate">{JSON.stringify(r.payload)}</pre> },
        { key: "created_at", label: "time", className: "w-40",
          render: (r) => <span className="text-muted-foreground">{new Date(r.created_at).toLocaleString()}</span> },
      ]}
      empty="No messages."
    />
  );
}

function CdcPanel() {
  const [tables, setTables] = useState<CdcTable[]>([]);
  const [lag, setLag] = useState<number | null>(null);
  const [schema, setSchema] = useState("public");
  const [table, setTable] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    if (!isLive()) return;
    try {
      const [t, l] = await Promise.all([cdc.listTables(), cdc.slotLag()]);
      setTables(t.tables); setLag(l.lag_bytes);
    } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { void refresh(); const id = setInterval(refresh, 15_000); return () => clearInterval(id); }, []);

  async function enable() {
    if (!table.trim()) return toast.error("Table required");
    setBusy(true);
    try { await cdc.enableTable(schema.trim() || "public", table.trim()); setTable(""); await refresh(); toast.success("Enabled"); }
    catch (e) { toast.error((e as Error).message); }
    finally { setBusy(false); }
  }
  async function disable(s: string, t: string) {
    if (!confirm(`Stop CDC on ${s}.${t}?`)) return;
    try { await cdc.disableTable(s, t); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-sm flex items-center gap-2">
        <Database className="h-4 w-4" /> Change data capture
        {lag !== null && (
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">
            slot lag: {lag.toLocaleString()} bytes
          </span>
        )}
      </CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Rows in these tables emit realtime events on <code>postgres_changes:&lt;schema&gt;:&lt;table&gt;</code>.
          Requires <code>PLUTO_ENABLE_CDC=1</code> on the server.
        </p>
        <div className="grid grid-cols-[120px,1fr,120px] gap-2">
          <Input placeholder="schema" value={schema} onChange={e => setSchema(e.target.value)} />
          <Input placeholder="table (e.g. todos)" value={table} onChange={e => setTable(e.target.value)} />
          <Button size="sm" onClick={enable} disabled={busy}>
            <Plus className="h-3 w-3 mr-1" /> Enable
          </Button>
        </div>
        <div className="space-y-1">
          {tables.map(row => (
            <div key={`${row.schema_name}.${row.table_name}`}
                 className="grid grid-cols-[1fr,90px,140px,60px] gap-2 items-center text-xs p-2 border border-border rounded-md">
              <span className="font-mono">{row.schema_name}.{row.table_name}</span>
              <Badge variant={row.enabled ? "default" : "secondary"}>{row.enabled ? "enabled" : "disabled"}</Badge>
              <span className="text-muted-foreground">since {new Date(row.created_at).toLocaleDateString()}</span>
              <div className="flex justify-end">
                {row.enabled && (
                  <Button size="sm" variant="ghost" onClick={() => disable(row.schema_name, row.table_name)}>
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
          ))}
          {tables.length === 0 && <div className="text-xs text-muted-foreground">No tables configured. Enable one above.</div>}
        </div>
      </CardContent>
    </Card>
  );
}
