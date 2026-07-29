// Outbound notification webhook for import jobs.
//
// Fires on: job applied (ok / failed), rollback failure, and any verification
// run that reports failures. Delivery is HMAC-signed (same scheme as the
// ingest endpoint) and every attempt is recorded on the import audit history
// with the actor and jobId.
//
// Config lives in `admin.import_settings` under `notify_webhook`, with an
// environment fallback (PLUTO_IMPORT_NOTIFY_URL / PLUTO_IMPORT_NOTIFY_SECRET).
import { appendImportEvent, getImportSetting } from "./import-jobs.server";

export type NotifyEvent =
  | "import.applied"
  | "import.apply_failed"
  | "import.rollback_failed"
  | "import.verification_failed";

export const NOTIFY_EVENTS: NotifyEvent[] = [
  "import.applied",
  "import.apply_failed",
  "import.rollback_failed",
  "import.verification_failed",
];

export type NotifyConfig = {
  url: string;
  secret?: string | null;
  events: NotifyEvent[];
  enabled: boolean;
};

export const NOTIFY_SETTING_KEY = "notify_webhook";

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, message: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

/** Stored config, falling back to environment variables. */
export async function readNotifyConfig(): Promise<NotifyConfig | null> {
  const stored = await getImportSetting<NotifyConfig>(NOTIFY_SETTING_KEY);
  if (stored?.url) {
    return {
      url: stored.url,
      secret: stored.secret ?? process.env.PLUTO_IMPORT_NOTIFY_SECRET ?? null,
      events: stored.events?.length ? stored.events : NOTIFY_EVENTS,
      enabled: stored.enabled !== false,
    };
  }
  const url = process.env.PLUTO_IMPORT_NOTIFY_URL;
  if (!url) return null;
  return { url, secret: process.env.PLUTO_IMPORT_NOTIFY_SECRET ?? null, events: NOTIFY_EVENTS, enabled: true };
}

/**
 * Deliver one notification and log the outcome to the audit history.
 * Never throws — a failed notification must not fail the import step.
 */
export async function notifyImportEvent(input: {
  event: NotifyEvent;
  jobId: string;
  actorId?: string | null;
  actorEmail?: string | null;
  payload: Record<string, unknown>;
}): Promise<{ delivered: boolean; status: number | null; error: string | null; url: string | null }> {
  let cfg: NotifyConfig | null = null;
  try {
    cfg = await readNotifyConfig();
  } catch {
    cfg = null;
  }
  if (!cfg || !cfg.enabled || !cfg.events.includes(input.event)) {
    return { delivered: false, status: null, error: null, url: cfg?.url ?? null };
  }

  const deliveryId = globalThis.crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    event: input.event,
    delivery_id: deliveryId,
    job_id: input.jobId,
    actor: input.actorEmail ?? null,
    actor_id: input.actorId ?? null,
    sent_at: new Date().toISOString(),
    data: input.payload,
  });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-pluto-event": input.event,
    "x-pluto-delivery": deliveryId,
    "x-pluto-timestamp": String(timestamp),
  };
  if (cfg.secret) headers["x-pluto-signature"] = `sha256=${await sign(cfg.secret, `${timestamp}.${body}`)}`;

  let status: number | null = null;
  let error: string | null = null;
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(cfg.url, { method: "POST", headers, body, signal: controller.signal });
    clearTimeout(timer);
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }

  const delivered = !error;
  await appendImportEvent({
    jobId: input.jobId,
    step: "webhook",
    ok: delivered,
    actorId: input.actorId ?? null,
    actorEmail: input.actorEmail ?? null,
    durationMs: Date.now() - startedAt,
    message: delivered
      ? `Notified ${input.event} → ${cfg.url} (HTTP ${status})`
      : `Notification failed for ${input.event} → ${cfg.url}: ${error}`,
    detail: { event: input.event, url: cfg.url, delivery_id: deliveryId, status, error, signed: Boolean(cfg.secret) },
  });

  return { delivered, status, error, url: cfg.url };
}
