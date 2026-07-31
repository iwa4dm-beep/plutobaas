import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Webhook, Send, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { testWebhookFn, verifySignatureFn, type WebhookTestResult } from "@/lib/pluto/webhook-tester.functions";
import { WebhookReplayPanel } from "@/components/pluto/webhook/WebhookReplayPanel";
import { recordDelivery } from "@/lib/pluto/webhook-deliveries";

export const Route = createFileRoute("/dashboard/webhook-tester")({
  head: () => ({
    meta: [
      { title: "Webhook tester — Pluto BaaS" },
      { name: "description", content: "Trigger signed webhook deliveries, verify HMAC signatures and simulate retries with live delivery status." },
      { property: "og:title", content: "Webhook tester — Pluto BaaS" },
      { property: "og:description", content: "Trigger, sign, verify and retry webhooks with real-time delivery status." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: WebhookTesterPage,
});

const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

type VerifyResult = {
  match: boolean; fresh: boolean; ageSeconds: number | null; expected: string; reason: string;
};

function WebhookTesterPage() {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [event, setEvent] = useState("import.applied");
  const [payload, setPayload] = useState('{\n  "jobId": "demo-1",\n  "status": "ok"\n}');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [backoffMs, setBackoffMs] = useState(500);
  const [simulateFailures, setSimulateFailures] = useState(0);
  const [allowPrivateHost, setAllowPrivateHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WebhookTestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [vSecret, setVSecret] = useState("");
  const [vTimestamp, setVTimestamp] = useState("");
  const [vBody, setVBody] = useState("");
  const [vSig, setVSig] = useState("");
  const [verify, setVerify] = useState<VerifyResult | null>(null);

  async function send() {
    setBusy(true); setErr(null); setResult(null);
    try {
      const r = await testWebhookFn({
        data: { url, secret, event, payload, maxAttempts, backoffMs, simulateFailures, allowPrivateHost, timeoutMs: 10_000, signatureHeader: "x-pluto-signature" },
      });
      setResult(r);
      if (r.error) setErr(r.error);
      if (!r.error) {
        const body = r.signedPayload.slice(r.timestamp.length + 1);
        recordDelivery({
          url: r.url,
          event: r.event,
          secret,
          body,
          timestamp: r.timestamp,
          signature: r.signature,
          signatureHeader: "x-pluto-signature",
          allowPrivateHost,
          status: r.ok ? "succeeded" : "failed",
          attempts: r.attempts.map((a) => ({
            attempt: a.attempt,
            status: a.status,
            ok: a.ok,
            durationMs: a.durationMs,
            delayedMs: a.delayedMs,
            error: a.error,
            responseBody: a.responseBody,
            at: new Date().toISOString(),
          })),
        });
        setVSecret(secret);
        setVTimestamp(r.timestamp);
        setVBody(r.signedPayload.slice(r.timestamp.length + 1));
        setVSig(r.signature);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function runVerify() {
    setVerify(null);
    try {
      const r = await verifySignatureFn({
        data: { secret: vSecret, timestamp: vTimestamp, body: vBody, signature: vSig, toleranceSeconds: 300 },
      });
      setVerify(r);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhook tester"
        description="Send an HMAC-signed delivery to any endpoint, watch every retry attempt in real time, and verify the signature exactly the way a receiver should."
      />

      {err ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div> : null}

      <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><Webhook className="h-4 w-4" /> Trigger</h2>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Endpoint URL</span>
            <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/api/webhooks/pluto" />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Signing secret</span>
            <input className={input} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="shared HMAC secret" />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Event</span>
            <input className={input} value={event} onChange={(e) => setEvent(e.target.value)} />
          </label>

          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Payload (JSON)</span>
            <textarea className={`${input} h-32 font-mono text-xs`} value={payload} onChange={(e) => setPayload(e.target.value)} />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Attempts</span>
              <input className={input} type="number" min={1} max={6} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Backoff ms</span>
              <input className={input} type="number" min={0} value={backoffMs} onChange={(e) => setBackoffMs(Number(e.target.value))} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Fail first</span>
              <input className={input} type="number" min={0} max={5} value={simulateFailures} onChange={(e) => setSimulateFailures(Number(e.target.value))} />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={allowPrivateHost} onChange={(e) => setAllowPrivateHost(e.target.checked)} />
            Allow private / localhost target
          </label>

          <button
            onClick={send}
            disabled={busy || !url}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            <Send className="h-4 w-4" /> {busy ? "Delivering…" : "Send test delivery"}
          </button>
        </section>

        <section className="space-y-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold">Delivery attempts</h2>
            {!result ? (
              <p className="text-sm text-muted-foreground">No delivery yet.</p>
            ) : (
              <div className="space-y-2">
                {result.attempts.map((a) => (
                  <div key={a.attempt} className="rounded-md border border-border/60 p-2.5">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium">Attempt {a.attempt}{a.delayedMs ? ` · waited ${a.delayedMs}ms` : ""}</span>
                      <span className={a.ok ? "text-emerald-500" : "text-destructive"}>
                        {a.status !== null ? `HTTP ${a.status}` : "no response"} · {a.durationMs}ms
                      </span>
                    </div>
                    {a.error ? <p className="mt-1 text-xs text-destructive">{a.error}</p> : null}
                    {a.responseBody ? (
                      <pre className="mt-1 max-h-32 overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px]">{a.responseBody}</pre>
                    ) : null}
                  </div>
                ))}
                <div className={`text-sm font-medium ${result.ok ? "text-emerald-500" : "text-destructive"}`}>
                  {result.ok ? "Delivered successfully." : "All attempts failed."}
                </div>
              </div>
            )}
          </div>

          {result && !result.error ? (
            <div className="rounded-lg border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Signed request</h2>
              <pre className="overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px]">
{Object.entries(result.headers).map(([k, v]) => `${k}: ${v}`).join("\n")}

{result.signedPayload}
              </pre>
            </div>
          ) : null}

          <div className="rounded-lg border border-border bg-card p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="h-4 w-4" /> Verify a signature</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              <input className={input} placeholder="secret" type="password" value={vSecret} onChange={(e) => setVSecret(e.target.value)} />
              <input className={input} placeholder="timestamp" value={vTimestamp} onChange={(e) => setVTimestamp(e.target.value)} />
            </div>
            <textarea className={`${input} mt-2 h-20 font-mono text-xs`} placeholder="raw body" value={vBody} onChange={(e) => setVBody(e.target.value)} />
            <input className={`${input} mt-2 font-mono text-xs`} placeholder="sha256=…" value={vSig} onChange={(e) => setVSig(e.target.value)} />
            <button onClick={runVerify} className="mt-2 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">Verify</button>
            {verify ? (
              <div className={`mt-3 rounded-md border p-2.5 text-sm ${verify.match && verify.fresh ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                {verify.reason}
                <div className="mt-1 break-all font-mono text-[11px] opacity-80">expected: {verify.expected}</div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <WebhookReplayPanel />
    </div>
  );
}
