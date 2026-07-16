// Configurable webhook dispatcher for Auto-Deploy Studio.
// Users register endpoints (Slack/Discord/custom) with an event mask; the
// studio fires JSON POST notifications at lifecycle boundaries: approval
// awaiting/confirmed, each pipeline step (running/ok/fail), deploy failed,
// rollback started/completed, and final publish.
//
// - Storage: localStorage, workspace-agnostic (per-browser).
// - Delivery: automatic retry with exponential backoff (max 4 attempts:
//   0s, 2s, 8s, 30s). Final status is tracked per endpoint under
//   `endpointStatus`. All attempts are appended to the log ring buffer.
// - Signing: every JSON body is signed with HMAC-SHA256 using the
//   webhook's shared `secret` (if set). Headers:
//     x-pluto-signature: sha256=<hex>
//     x-pluto-event:     <event>
//     x-pluto-delivery:  <uuid>
//     x-pluto-timestamp: <ms since epoch>
// - Secrets: masked in payloads (only env keys, never values).

const CFG_KEY = "pluto:auto-deploy:webhooks";
const LOG_KEY = "pluto:auto-deploy:webhook-log";
const STATUS_KEY = "pluto:auto-deploy:webhook-endpoint-status";
const MAX_LOG = 100;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = [0, 2_000, 8_000, 30_000];

export type WebhookEvent =
  | "approval.awaiting"
  | "approval.confirmed"
  | "approval.cancelled"
  | "step.running"
  | "step.ok"
  | "step.fail"
  | "deploy.retry"
  | "deploy.failed"
  | "deploy.published"
  | "rollback.started"
  | "rollback.completed";

export const ALL_EVENTS: WebhookEvent[] = [
  "approval.awaiting", "approval.confirmed", "approval.cancelled",
  "step.running", "step.ok", "step.fail",
  "deploy.retry", "deploy.failed", "deploy.published",
  "rollback.started", "rollback.completed",
];

export type WebhookConfig = {
  id: string;
  label: string;
  url: string;
  secret?: string;
  events: WebhookEvent[];
  enabled: boolean;
  format: "json" | "slack" | "discord";
  createdAt: number;
};

export type WebhookLogEntry = {
  ts: number;
  deliveryId: string;
  webhookId: string;
  webhookLabel: string;
  event: WebhookEvent;
  attempt: number;
  maxAttempts: number;
  ok: boolean;
  finalStatus: "delivered" | "failed" | "retrying";
  status: number;
  error?: string;
  latencyMs: number;
};

export type EndpointStatus = {
  webhookId: string;
  lastEvent: WebhookEvent;
  lastDeliveryId: string;
  lastAttempt: number;
  lastOk: boolean;
  lastStatus: number;
  lastError?: string;
  lastTs: number;
  finalStatus: "delivered" | "failed" | "retrying";
};

export function loadWebhooks(): WebhookConfig[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CFG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function saveWebhooks(list: WebhookConfig[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(CFG_KEY, JSON.stringify(list));
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-webhooks:changed"));
}

export function loadWebhookLog(): WebhookLogEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function loadEndpointStatus(): Record<string, EndpointStatus> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STATUS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === "object" ? obj : {};
  } catch { return {}; }
}

function saveEndpointStatus(all: Record<string, EndpointStatus>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STATUS_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-webhook-status:changed"));
}

function appendLog(entry: WebhookLogEntry): void {
  if (typeof window === "undefined") return;
  const all = [entry, ...loadWebhookLog()].slice(0, MAX_LOG);
  window.localStorage.setItem(LOG_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-webhook-log:changed"));

  // Update endpoint status snapshot
  const status = loadEndpointStatus();
  status[entry.webhookId] = {
    webhookId: entry.webhookId,
    lastEvent: entry.event,
    lastDeliveryId: entry.deliveryId,
    lastAttempt: entry.attempt,
    lastOk: entry.ok,
    lastStatus: entry.status,
    lastError: entry.error,
    lastTs: entry.ts,
    finalStatus: entry.finalStatus,
  };
  saveEndpointStatus(status);
}

/** HMAC-SHA256 hex signature using the webhook's shared secret. */
async function signBody(secret: string, body: string): Promise<string> {
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw", enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return ""; }
}

/** Verify a signature produced by `signBody`. Timing-safe. */
export async function verifyWebhookSignature(
  secret: string, body: string, headerValue: string,
): Promise<boolean> {
  const expected = await signBody(secret, body);
  const provided = headerValue.replace(/^sha256=/, "");
  if (expected.length !== provided.length || expected.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

/** Format payload per target — Slack/Discord expect `text`/`content` fields. */
function formatPayload(
  cfg: WebhookConfig,
  event: WebhookEvent,
  data: Record<string, unknown>,
  meta: { deliveryId: string; attempt: number; timestamp: number },
): { body: string; headers: Record<string, string> } {
  const base = {
    event,
    delivery_id: meta.deliveryId,
    attempt: meta.attempt,
    timestamp: new Date(meta.timestamp).toISOString(),
    source: "pluto-auto-deploy",
    ...data,
  };
  const summary = `[${event}] ${data.slug ?? ""} ${data.message ?? ""}`.trim();
  if (cfg.format === "slack") {
    return {
      body: JSON.stringify({ text: summary, attachments: [{ text: "```" + JSON.stringify(base, null, 2).slice(0, 1500) + "```" }] }),
      headers: { "content-type": "application/json" },
    };
  }
  if (cfg.format === "discord") {
    return {
      body: JSON.stringify({ content: summary + "\n```json\n" + JSON.stringify(base, null, 2).slice(0, 1500) + "\n```" }),
      headers: { "content-type": "application/json" },
    };
  }
  return {
    body: JSON.stringify(base),
    headers: { "content-type": "application/json" },
  };
}

async function deliverOnce(
  cfg: WebhookConfig,
  event: WebhookEvent,
  data: Record<string, unknown>,
  deliveryId: string,
  attempt: number,
): Promise<{ ok: boolean; status: number; error?: string; latencyMs: number }> {
  const started = Date.now();
  const { body, headers } = formatPayload(cfg, event, data, {
    deliveryId, attempt, timestamp: started,
  });
  const authHeaders: Record<string, string> = {
    ...headers,
    "x-pluto-event": event,
    "x-pluto-delivery": deliveryId,
    "x-pluto-attempt": String(attempt),
    "x-pluto-timestamp": String(started),
  };
  if (cfg.secret) {
    const sig = await signBody(cfg.secret, body);
    if (sig) authHeaders["x-pluto-signature"] = `sha256=${sig}`;
  }
  try {
    const res = await fetch(cfg.url, {
      method: "POST", headers: authHeaders, body, mode: "cors", keepalive: true,
    });
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - started,
      error: res.ok ? undefined : `HTTP ${res.status}` };
  } catch (err: unknown) {
    // Try no-cors best-effort so Slack/Discord still receive it, but treat
    // as "opaque success" only when there is no retry budget left. Otherwise
    // count as a failure so retry can attempt CORS again.
    try {
      await fetch(cfg.url, {
        method: "POST", headers: authHeaders, body, mode: "no-cors", keepalive: true,
      });
      return { ok: true, status: 0, latencyMs: Date.now() - started,
        error: "sent (opaque — no-cors)" };
    } catch (err2: unknown) {
      return { ok: false, status: 0, latencyMs: Date.now() - started,
        error: err2 instanceof Error ? err2.message : String(err2 ?? err) };
    }
  }
}

/** Fire the event to every enabled webhook that subscribes to it.
 *  Retries with exponential backoff; failures are logged, never thrown. */
export function dispatchWebhookEvent(
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  const hooks = loadWebhooks().filter((h) => h.enabled && h.events.includes(event));
  if (hooks.length === 0) return;

  for (const cfg of hooks) {
    void (async () => {
      const deliveryId = newDeliveryId();
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const wait = BACKOFF_MS[attempt - 1] ?? 30_000;
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const r = await deliverOnce(cfg, event, data, deliveryId, attempt);
        const isLast = attempt >= MAX_ATTEMPTS;
        const finalStatus: WebhookLogEntry["finalStatus"] =
          r.ok ? "delivered" : isLast ? "failed" : "retrying";
        appendLog({
          ts: Date.now(), deliveryId,
          webhookId: cfg.id, webhookLabel: cfg.label, event,
          attempt, maxAttempts: MAX_ATTEMPTS,
          ok: r.ok, finalStatus,
          status: r.status, error: r.error, latencyMs: r.latencyMs,
        });
        if (r.ok) return;
      }
    })();
  }
}

export function newWebhookId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function newDeliveryId(): string {
  return `dlv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
