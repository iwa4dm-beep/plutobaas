// Outbound webhook settings for import job completion / failure /
// verification failure. Deliveries are HMAC-signed and audited.
import { useCallback, useEffect, useState } from "react";
import { Webhook } from "lucide-react";
import {
  getNotifySettingsFn,
  saveNotifySettingsFn,
  testNotifyFn,
  type NotifySettingsView,
} from "@/lib/pluto/import-job.functions";

export function NotifyWebhookCard({ testJobId }: { testJobId?: string | null }) {
  const [settings, setSettings] = useState<NotifySettingsView | null>(null);
  const [allEvents, setAllEvents] = useState<string[]>([]);
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await getNotifySettingsFn();
      if (!r.ok) { setErr(r.error); return; }
      setAllEvents(r.allEvents);
      setSettings(r.settings);
      setUrl(r.settings?.url ?? "");
      setEvents(r.settings?.events ?? r.allEvents);
      setEnabled(r.settings?.enabled ?? true);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await saveNotifySettingsFn({ data: { url, secret: secret || undefined, events, enabled } });
      if (!r.ok) setErr(r.error);
      else { setMsg("Saved."); setSecret(""); await load(); }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function test() {
    if (!testJobId) { setErr("Run an import first — a test needs a job id."); return; }
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await testNotifyFn({ data: { id: testJobId } });
      if (!r.ok) setErr(r.error ?? `Delivery failed${r.status ? ` (HTTP ${r.status})` : ""}`);
      else setMsg(`Delivered to ${r.url} (HTTP ${r.status}). Logged in the audit history.`);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="text-sm font-medium inline-flex items-center gap-1">
        <Webhook className="h-4 w-4" /> Import notifications
      </div>
      <p className="text-xs text-muted-foreground">
        POSTs a signed JSON payload when an import is applied, fails, or verification fails.
        The body is signed with <code className="font-mono">X-Pluto-Signature: sha256=…</code> and every attempt is
        recorded in the audit history with the actor and job id.
      </p>

      <div className="grid gap-2 md:grid-cols-[1fr,1fr] text-xs">
        <label className="space-y-1">
          <span className="text-muted-foreground">Webhook URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/hooks/pluto"
            className="w-full rounded border bg-background px-2 py-1 font-mono" />
        </label>
        <label className="space-y-1">
          <span className="text-muted-foreground">
            Signing secret {settings?.hasSecret ? "(saved — leave blank to keep)" : ""}
          </span>
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••"
            className="w-full rounded border bg-background px-2 py-1 font-mono" />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        {allEvents.map((ev) => (
          <label key={ev} className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              checked={events.includes(ev)}
              onChange={(e) => setEvents((s) => (e.target.checked ? [...s, ev] : s.filter((x) => x !== ev)))}
            />
            <code className="font-mono">{ev}</code>
          </label>
        ))}
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> enabled
        </label>
        <div className="ml-auto space-x-2">
          <button className="underline" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
          <button className="underline" disabled={busy} onClick={() => void test()}>Send test</button>
        </div>
      </div>

      {msg && <p className="text-xs text-primary">{msg}</p>}
      {err && <p className="text-xs text-destructive">{err}</p>}
      {settings?.fromEnv && (
        <p className="text-[11px] text-muted-foreground">Currently using the project-secret configuration.</p>
      )}
    </div>
  );
}
