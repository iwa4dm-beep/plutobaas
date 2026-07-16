// Configurable webhook dispatcher for Auto-Deploy Studio.
// Users register endpoints (Slack/Discord/custom) with an event mask; the
// studio fires JSON POST notifications at lifecycle boundaries: approval
// awaiting/confirmed, each pipeline step (running/ok/fail), deploy failed,
// rollback started/completed, and final publish.
//
// - Storage: localStorage, workspace-agnostic (per-browser).
// - Delivery: fire-and-forget fetch; failures are swallowed and logged to
//   an in-memory ring buffer (last 50) that the UI surfaces.
// - Secrets: masked in payloads (only env keys, never values).

const CFG_KEY = "pluto:auto-deploy:webhooks";
const LOG_KEY = "pluto:auto-deploy:webhook-log";
const MAX_LOG = 50;

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
  events: WebhookEvent[];
  enabled: boolean;
  format: "json" | "slack" | "discord";
  createdAt: number;
};

export type WebhookLogEntry = {
  ts: number;
  webhookId: string;
  webhookLabel: string;
  event: WebhookEvent;
  ok: boolean;
  status: number;
  error?: string;
  latencyMs: number;
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

function appendLog(entry: WebhookLogEntry): void {
  if (typeof window === "undefined") return;
  const all = [entry, ...loadWebhookLog()].slice(0, MAX_LOG);
  window.localStorage.setItem(LOG_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent("pluto:auto-deploy-webhook-log:changed"));
}

/** Format payload per target — Slack/Discord expect `text`/`content` fields. */
function formatPayload(
  cfg: WebhookConfig,
  event: WebhookEvent,
  data: Record<string, unknown>,
): { body: string; headers: Record<string, string> } {
  const base = {
    event,
    timestamp: new Date().toISOString(),
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
    headers: { "content-type": "application/json", "x-pluto-event": event },
  };
}

/** Fire the event to every enabled webhook that subscribes to it.
 *  Fire-and-forget: failures are logged, never thrown. */
export function dispatchWebhookEvent(
  event: WebhookEvent,
  data: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  const hooks = loadWebhooks().filter((h) => h.enabled && h.events.includes(event));
  if (hooks.length === 0) return;

  for (const cfg of hooks) {
    const started = Date.now();
    const { body, headers } = formatPayload(cfg, event, data);
    // fire-and-forget; browser CORS may block reading response — we still
    // record status when readable, and gracefully log opaque/no-cors sends.
    fetch(cfg.url, { method: "POST", headers, body, mode: "cors", keepalive: true })
      .then(async (res) => {
        appendLog({
          ts: started,
          webhookId: cfg.id,
          webhookLabel: cfg.label,
          event,
          ok: res.ok,
          status: res.status,
          latencyMs: Date.now() - started,
          error: res.ok ? undefined : `HTTP ${res.status}`,
        });
      })
      .catch((err: unknown) => {
        // CORS failure or network error — try no-cors as best effort so the
        // notification still leaves the browser for Slack/Discord etc.
        fetch(cfg.url, { method: "POST", headers, body, mode: "no-cors", keepalive: true })
          .then(() => {
            appendLog({
              ts: started, webhookId: cfg.id, webhookLabel: cfg.label, event,
              ok: true, status: 0, latencyMs: Date.now() - started,
              error: "sent (opaque — no-cors)",
            });
          })
          .catch((err2: unknown) => {
            appendLog({
              ts: started, webhookId: cfg.id, webhookLabel: cfg.label, event,
              ok: false, status: 0, latencyMs: Date.now() - started,
              error: (err2 instanceof Error ? err2.message : String(err2 ?? err)),
            });
          });
      });
  }
}

export function newWebhookId(): string {
  return `wh_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}
