import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { rt2, isLive, type Rt2Channel, type Rt2Message, type Rt2Member } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Radio, Users2, Send, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

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

  async function refresh() {
    if (!isLive()) return;
    try { const r = await rt2.channels(); setChannels(r.channels); if (!active && r.channels[0]) setActive(r.channels[0].name); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function refreshChannel(name: string) {
    try { const [m, p] = await Promise.all([rt2.messages(name, 50), rt2.presence(name)]); setMessages(m.messages); setMembers(p.members); }
    catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (!active) return; refreshChannel(active); const t = setInterval(() => refreshChannel(active), 3000); return () => clearInterval(t); }, [active]);

  async function createChannel() {
    if (!newName.trim()) return;
    try { await rt2.createChannel(newName.trim(), "broadcast"); setNewName(""); toast.success("Channel created"); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function send() {
    if (!active) return;
    try { const parsed = JSON.parse(payload); await rt2.broadcast(active, event, parsed, memberKey); await refreshChannel(active); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function join() {
    if (!active) return;
    await rt2.join(active, memberKey, { joinedAt: new Date().toISOString() }); await refreshChannel(active);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Radio className="h-5 w-5" /> Realtime channels</h1>
          <p className="text-sm text-muted-foreground">Broadcast events and track presence per channel.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
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
                  <Button size="sm" variant="outline" onClick={join}>Join</Button>
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
              <CardContent className="space-y-1 max-h-[400px] overflow-y-auto">
                {messages.map(m => (
                  <div key={m.id} className="text-xs p-2 rounded-md border border-border">
                    <div className="flex justify-between"><span className="font-medium">{m.event}</span><span className="text-muted-foreground">{new Date(m.created_at).toLocaleTimeString()}</span></div>
                    <pre className="text-[10px] font-mono text-muted-foreground overflow-x-auto">{JSON.stringify(m.payload)}</pre>
                  </div>
                ))}
                {messages.length === 0 && <div className="text-xs text-muted-foreground">No messages.</div>}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
