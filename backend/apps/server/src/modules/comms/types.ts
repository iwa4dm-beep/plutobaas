/**
 * Public types for the Communications module.
 *
 * These live in their own file so both the server routes and the eventual
 * SDK client (Phase 14.5) import from the same source of truth.
 */

export type EmailOutbound = {
  workspace_id: string;
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
};

export type SmsOutbound = {
  workspace_id: string;
  from: string;
  to: string;
  body: string;
};

export type EmailProviderResult = { providerId: string };
export type SmsProviderResult   = { providerId: string; segments: number };

export interface EmailDriver {
  readonly name: "smtp" | "resend" | "ses" | "postmark";
  send(msg: EmailOutbound): Promise<EmailProviderResult>;
}

export interface SmsDriver {
  readonly name: "twilio" | "messagebird" | "log";
  send(msg: SmsOutbound): Promise<SmsProviderResult>;
}

/**
 * Webhook event names. The retry worker fans these out as they occur
 * across the platform; the list is the authoritative allow-list against
 * which webhook subscriptions are validated at creation time.
 */
export const WEBHOOK_EVENTS = [
  "email.queued",
  "email.delivered",
  "email.failed",
  "email.bounced",
  "sms.queued",
  "sms.delivered",
  "sms.failed",
  "storage.object.created",
  "storage.object.deleted",
  "auth.user.created",
  "auth.user.deleted",
  "db.row.inserted",
  "db.row.updated",
  "db.row.deleted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
