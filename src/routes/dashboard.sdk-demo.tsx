import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createClient, type PlutoClient, type Session } from "@pluto/client";

export const Route = createFileRoute("/dashboard/sdk-demo")({
  component: SdkDemo,
});

type Row = Record<string, unknown> & { id?: string };
type RealtimeFrame = { seq: number; payload: unknown };

const DEFAULT_URL =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_PLUTO_URL ?? "http://localhost:3000";
const DEFAULT_ANON =
  (import.meta as unknown as { env: Record<string, string | undefined> }).env
    .VITE_PLUTO_ANON_KEY ?? "dev-anon-key";

function SdkDemo() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL);
  const [apikey, setApikey] = useState(DEFAULT_ANON);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [table, setTable] = useState("posts");
  const [rows, setRows] = useState<Row[]>([]);
  const [room, setRoom] = useState("demo");
  const [messages, setMessages] = useState<RealtimeFrame[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const subRef = useRef<{ close: () => void } | null>(null);

  const client: PlutoClient = useMemo(
    () => createClient({ baseUrl, apikey }),
    [baseUrl, apikey],
  );

  useEffect(() => () => subRef.current?.close(), []);

  async function signIn() {
    setErr(null); setBusy(true);
    try { setSession(await client.auth.signIn(email, password)); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function loadRows() {
    setErr(null); setBusy(true);
    try {
      const r = await client.data.query<Row>({ table, limit: 25 });
      setRows(r.rows);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  function subscribe() {
    subRef.current?.close();
    setMessages([]);
    subRef.current = client.realtime.subscribe(room, {
      onMessage: (m) => setMessages((prev) => [{ seq: m.seq, payload: m.payload }, ...prev].slice(0, 50)),
    });
  }

  async function publish() {
    try { await client.realtime.publish({ room, payload: { text: `hi @ ${new Date().toLocaleTimeString()}` } }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-6">
      <PageHeader title="SDK Demo" description="Login → list → realtime, via the typed @pluto/client SDK." />

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">1. Connection</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label>Base URL</Label><Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></div>
          <div><Label>API key (anon)</Label><Input value={apikey} onChange={(e) => setApikey(e.target.value)} /></div>
        </div>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">2. Sign in</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div><Label>Email</Label><Input value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          <div><Label>Password</Label><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        </div>
        <div className="flex items-center gap-3">
          <Button onClick={signIn} disabled={busy || !password}>Sign in</Button>
          {session && <span className="text-xs text-muted-foreground">signed in as {session.user.email ?? session.user.id}</span>}
        </div>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">3. Data API — list rows</h2>
        <div className="flex items-end gap-2">
          <div className="flex-1"><Label>Table</Label><Input value={table} onChange={(e) => setTable(e.target.value)} /></div>
          <Button onClick={loadRows} disabled={busy}>Fetch</Button>
        </div>
        <pre className="text-xs bg-muted rounded p-3 overflow-auto max-h-64">{JSON.stringify(rows, null, 2)}</pre>
      </section>

      <section className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold">4. Realtime — subscribe &amp; publish</h2>
        <div className="flex items-end gap-2">
          <div className="flex-1"><Label>Room</Label><Input value={room} onChange={(e) => setRoom(e.target.value)} /></div>
          <Button variant="outline" onClick={subscribe}>Subscribe</Button>
          <Button onClick={publish}>Publish test</Button>
        </div>
        <ul className="text-xs bg-muted rounded p-3 max-h-48 overflow-auto space-y-1">
          {messages.length === 0
            ? <li className="text-muted-foreground">no messages yet — subscribe then publish</li>
            : messages.map((m) => <li key={m.seq}><span className="font-mono">#{m.seq}</span> {JSON.stringify(m.payload)}</li>)}
        </ul>
      </section>

      {err && <div className="rounded-md border border-destructive/50 bg-destructive/10 text-destructive text-sm p-3">{err}</div>}
    </div>
  );
}
