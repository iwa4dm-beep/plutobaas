// Replay a stored webhook delivery by id, with configurable backoff, optional
// re-signing and live per-attempt status.
import { useEffect, useMemo, useRef, useState } from "react";
import { History, RotateCcw, Square, Copy } from "lucide-react";
import {
  appendAttempt,
  backoffFor,
  getDelivery,
  listDeliveries,
  newDeliveryId,
  recordDelivery,
  subscribeDeliveries,
  updateDelivery,
  type DeliveryRecord,
} from "@/lib/pluto/webhook-deliveries";
import { replayAttemptFn, verifySignatureFn } from "@/lib/pluto/webhook-tester.functions";

const input = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm";

type Verify = { match: boolean; fresh: boolean; ageSeconds: number | null; expected: string; reason: string };

export function WebhookReplayPanel() {
  const [rows, setRows] = useState<DeliveryRecord[]>(() => listDeliveries());
  const [deliveryId, setDeliveryId] = useState("");
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [backoffMs, setBackoffMs] = useState(1000);
  const [jitter, setJitter] = useState(true);
  const [resign, setResign] = useState(true);
  const [verifySig, setVerifySig] = useState(true);
  const [running, setRunning] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [verify, setVerify] = useState<Verify | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const stopRef = useRef(false);

  useEffect(() => subscribeDeliveries(() => setRows(listDeliveries())), []);

  const source = useMemo(() => (deliveryId ? getDelivery(deliveryId) : null), [deliveryId, rows]);
  const active = useMemo(() => (activeId ? rows.find((r) => r.id === activeId) ?? null : null), [activeId, rows]);

  async function replay() {
    const src = getDelivery(deliveryId);
    if (!src) { setErr(`No stored delivery matches "${deliveryId}".`); return; }
    setErr(null); setVerify(null); setRunning(true); stopRef.current = false;

    const replayRow = recordDelivery({
      id: newDeliveryId(),
      url: src.url,
      event: src.event,
      secret: src.secret,
      body: src.body,
      timestamp: src.timestamp,
      signature: src.signature,
      signatureHeader: src.signatureHeader,
      allowPrivateHost: src.allowPrivateHost,
      status: "delivering",
      attempts: [],
      replayOf: src.id,
    });
    updateDelivery(src.id, { replayCount: src.replayCount + 1 });
    setActiveId(replayRow.id);

    let lastTimestamp = src.timestamp;
    let lastSignature = src.signature;
    let ok = false;

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (stopRef.current) break;
        const wait = backoffFor(attempt, backoffMs, jitter);
        for (let left = wait; left > 0 && !stopRef.current; left -= 200) {
          setCountdown(left);
          await new Promise((r) => setTimeout(r, Math.min(200, left)));
        }
        setCountdown(0);
        if (stopRef.current) break;

        const res = await replayAttemptFn({
          data: {
            url: src.url,
            event: src.event,
            body: src.body,
            secret: src.secret,
            resign,
            timestamp: src.timestamp,
            signature: src.signature,
            signatureHeader: src.signatureHeader,
            deliveryId: replayRow.id,
            attempt,
            timeoutMs: 10_000,
            allowPrivateHost: src.allowPrivateHost,
          },
        });
        lastTimestamp = res.timestamp;
        lastSignature = res.signature;
        appendAttempt(replayRow.id, {
          attempt,
          status: res.status,
          ok: res.ok,
          durationMs: res.durationMs,
          delayedMs: wait,
          error: "error" in res ? res.error : undefined,
          responseBody: "responseBody" in res ? res.responseBody : undefined,
          at: new Date().toISOString(),
        });
        if (res.ok) { ok = true; break; }
      }

      updateDelivery(replayRow.id, {
        status: ok ? "succeeded" : "failed",
        timestamp: lastTimestamp,
        signature: lastSignature,
      });

      if (verifySig && src.secret) {
        const v = await verifySignatureFn({
          data: { secret: src.secret, timestamp: lastTimestamp, body: src.body, signature: lastSignature, toleranceSeconds: 300 },
        });
        setVerify(v);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      updateDelivery(replayRow.id, { status: "failed" });
    } finally {
      setRunning(false);
      setCountdown(0);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold">
        <History className="h-4 w-4" /> Replay a past delivery
      </h2>

      {err ? <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{err}</div> : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Delivery id</span>
            <input className={`${input} font-mono text-xs`} value={deliveryId} onChange={(e) => setDeliveryId(e.target.value)} placeholder="dlv_…" />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Max attempts</span>
              <input className={input} type="number" min={1} max={10} value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">Base backoff (ms)</span>
              <input className={input} type="number" min={0} value={backoffMs} onChange={(e) => setBackoffMs(Number(e.target.value))} />
            </label>
          </div>

          <div className="space-y-1.5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={jitter} onChange={(e) => setJitter(e.target.checked)} /> Full jitter on backoff</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={resign} onChange={(e) => setResign(e.target.checked)} /> Re-sign with a fresh timestamp</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={verifySig} onChange={(e) => setVerifySig(e.target.checked)} /> Verify signature after replay</label>
          </div>

          {source ? (
            <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs">
              <div className="truncate"><span className="text-muted-foreground">to </span>{source.url}</div>
              <div><span className="text-muted-foreground">event </span>{source.event} · <span className="text-muted-foreground">replays </span>{source.replayCount}</div>
              <pre className="mt-1 max-h-24 overflow-auto font-mono text-[11px]">{source.body}</pre>
            </div>
          ) : null}

          <div className="flex gap-2">
            <button
              onClick={replay}
              disabled={running || !deliveryId}
              className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" /> {running ? (countdown ? `Retrying in ${Math.ceil(countdown / 100) / 10}s…` : "Replaying…") : "Replay delivery"}
            </button>
            {running ? (
              <button onClick={() => { stopRef.current = true; }} className="flex items-center gap-1 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
                <Square className="h-3.5 w-3.5" /> Stop
              </button>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Live status {active ? `· ${active.id}` : ""}</div>
          {!active ? (
            <p className="text-sm text-muted-foreground">Pick a delivery id and hit replay.</p>
          ) : (
            <>
              <div className={`text-sm font-medium ${active.status === "succeeded" ? "text-emerald-500" : active.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                {active.status}
              </div>
              {active.attempts.map((a) => (
                <div key={a.attempt} className="rounded-md border border-border/60 p-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">Attempt {a.attempt}{a.delayedMs ? ` · waited ${a.delayedMs}ms` : ""}</span>
                    <span className={a.ok ? "text-emerald-500" : "text-destructive"}>
                      {a.status !== null ? `HTTP ${a.status}` : "no response"} · {a.durationMs}ms
                    </span>
                  </div>
                  {a.error ? <p className="mt-1 text-destructive">{a.error}</p> : null}
                  {a.responseBody ? <pre className="mt-1 max-h-24 overflow-auto rounded bg-muted/40 p-1.5 font-mono text-[11px]">{a.responseBody}</pre> : null}
                </div>
              ))}
              {running && countdown > 0 ? <div className="text-xs text-muted-foreground">Backing off {Math.ceil(countdown / 100) / 10}s before the next attempt…</div> : null}
              {verify ? (
                <div className={`rounded-md border p-2 text-xs ${verify.match && verify.fresh ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                  {verify.reason}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      <div className="mt-4">
        <div className="mb-2 text-xs font-medium text-muted-foreground">Delivery log ({rows.length})</div>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deliveries recorded yet — send a test delivery first.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-md border border-border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-left">Delivery id</th>
                  <th className="p-2 text-left">Event</th>
                  <th className="p-2 text-left">Status</th>
                  <th className="p-2 text-left">Attempts</th>
                  <th className="p-2 text-left">When</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-t border-border/60">
                    <td className="p-2 font-mono">
                      {d.id}
                      {d.replayOf ? <span className="ml-1 text-muted-foreground">↺ {d.replayOf}</span> : null}
                    </td>
                    <td className="p-2">{d.event}</td>
                    <td className={`p-2 ${d.status === "succeeded" ? "text-emerald-500" : d.status === "failed" ? "text-destructive" : ""}`}>{d.status}</td>
                    <td className="p-2">{d.attempts.length}</td>
                    <td className="p-2">{new Date(d.updatedAt).toLocaleTimeString()}</td>
                    <td className="p-2 text-right">
                      <button onClick={() => setDeliveryId(d.id)} className="mr-2 underline">Use</button>
                      <button onClick={() => void navigator.clipboard?.writeText(d.id)} className="inline-flex items-center gap-1 underline">
                        <Copy className="h-3 w-3" /> id
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
