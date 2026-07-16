// JSON schemas + example payloads for every Auto-Deploy webhook event.
// Rendered in the "Payload Schemas" panel and downloadable as a bundle so
// integrators can codegen against them.

import type { WebhookEvent } from "./auto-deploy-webhooks";
import { ALL_EVENTS } from "./auto-deploy-webhooks";

export type PayloadSchema = {
  event: WebhookEvent;
  title: string;
  description: string;
  /** JSON-Schema-ish shape (draft-07 subset). */
  schema: Record<string, unknown>;
  example: Record<string, unknown>;
};

const COMMON_PROPS = {
  event: { type: "string", description: "Lifecycle event name" },
  delivery_id: { type: "string", description: "Unique per-delivery id (stable across retries)" },
  attempt: { type: "integer", minimum: 1, description: "Delivery attempt number" },
  timestamp: { type: "string", format: "date-time" },
  source: { type: "string", const: "pluto-auto-deploy" },
  slug: { type: "string", description: "Deployment slug / bundle identifier" },
} as const;

function schemaFor(
  event: WebhookEvent,
  extra: Record<string, unknown> = {},
  required: string[] = [],
): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft-07/schema#",
    title: `pluto.auto-deploy.${event}`,
    type: "object",
    additionalProperties: false,
    properties: { ...COMMON_PROPS, ...extra },
    required: ["event", "delivery_id", "attempt", "timestamp", "source", ...required],
  };
}

const now = "2026-07-16T12:00:00.000Z";
const baseExample = (event: WebhookEvent, extra: Record<string, unknown> = {}) => ({
  event, delivery_id: "dlv_abc123", attempt: 1, timestamp: now,
  source: "pluto-auto-deploy", slug: "app-2026-07-16-x1", ...extra,
});

export const PAYLOAD_SCHEMAS: Record<WebhookEvent, PayloadSchema> = {
  "approval.awaiting": {
    event: "approval.awaiting",
    title: "Approval awaiting",
    description: "Pipeline paused — waiting for a human approver.",
    schema: schemaFor("approval.awaiting", {
      plan: { type: "object", description: "Analyzer output" },
      message: { type: "string" },
    }),
    example: baseExample("approval.awaiting", { message: "Awaiting approval" }),
  },
  "approval.confirmed": {
    event: "approval.confirmed",
    title: "Approval confirmed",
    description: "Human approver signed off; deploy is starting.",
    schema: schemaFor("approval.confirmed", {
      approver: { type: "string" },
    }, ["approver"]),
    example: baseExample("approval.confirmed", { approver: "you@example.com" }),
  },
  "approval.cancelled": {
    event: "approval.cancelled",
    title: "Approval cancelled",
    description: "Approver rejected or aborted the pending deploy.",
    schema: schemaFor("approval.cancelled", { reason: { type: "string" } }),
    example: baseExample("approval.cancelled", { reason: "user-cancelled" }),
  },
  "step.running": {
    event: "step.running",
    title: "Pipeline step running",
    description: "A pipeline step has started.",
    schema: schemaFor("step.running", {
      step: { type: "string" }, label: { type: "string" },
    }, ["step"]),
    example: baseExample("step.running", { step: "unpack-serve", label: "Unpack & serve" }),
  },
  "step.ok": {
    event: "step.ok",
    title: "Pipeline step succeeded",
    description: "A pipeline step finished successfully.",
    schema: schemaFor("step.ok", {
      step: { type: "string" }, latencyMs: { type: "integer" },
    }, ["step"]),
    example: baseExample("step.ok", { step: "unpack-serve", latencyMs: 1240 }),
  },
  "step.fail": {
    event: "step.fail",
    title: "Pipeline step failed",
    description: "A pipeline step failed after all in-step retries.",
    schema: schemaFor("step.fail", {
      step: { type: "string" }, error: { type: "string" }, latencyMs: { type: "integer" },
    }, ["step", "error"]),
    example: baseExample("step.fail", { step: "health-check", error: "500 on /health" }),
  },
  "deploy.retry": {
    event: "deploy.retry",
    title: "Deploy self-heal retry",
    description: "The studio is retrying the pipeline after a transient failure.",
    schema: schemaFor("deploy.retry", {
      attempt: { type: "integer" }, reason: { type: "string" },
    }),
    example: baseExample("deploy.retry", { attempt: 2, reason: "HTTP 502" }),
  },
  "deploy.failed": {
    event: "deploy.failed",
    title: "Deploy failed",
    description: "Pipeline exhausted retries and stopped in an error state.",
    schema: schemaFor("deploy.failed", {
      error: { type: "string" }, failedStep: { type: "string" },
    }, ["error"]),
    example: baseExample("deploy.failed", { error: "Health check failed", failedStep: "health-check" }),
  },
  "deploy.published": {
    event: "deploy.published",
    title: "Deploy published",
    description: "Pipeline finished successfully; the bundle is live.",
    schema: schemaFor("deploy.published", {
      liveUrl: { type: "string", format: "uri" },
      totalMs: { type: "integer" },
      envKeys: { type: "array", items: { type: "string" }, description: "Env-var NAMES only; values are never emitted." },
    }, ["liveUrl"]),
    example: baseExample("deploy.published", {
      liveUrl: "https://app-2026-07-16-x1.apps.timescard.cloud",
      totalMs: 42_123,
      envKeys: ["APP_KEY", "DB_URL"],
    }),
  },
  "rollback.started": {
    event: "rollback.started",
    title: "Rollback started",
    description: "Studio is rolling back to the previous successful bundle.",
    schema: schemaFor("rollback.started", {
      targetSlug: { type: "string" },
    }, ["targetSlug"]),
    example: baseExample("rollback.started", { targetSlug: "app-2026-07-15-w9" }),
  },
  "rollback.completed": {
    event: "rollback.completed",
    title: "Rollback completed",
    description: "Rollback finished; previous version is live again.",
    schema: schemaFor("rollback.completed", {
      restoredSlug: { type: "string" }, liveUrl: { type: "string", format: "uri" },
    }, ["restoredSlug"]),
    example: baseExample("rollback.completed", {
      restoredSlug: "app-2026-07-15-w9",
      liveUrl: "https://app-2026-07-15-w9.apps.timescard.cloud",
    }),
  },
};

/** Full bundle (all events) as one JSON document for download. */
export function buildSchemaBundle(): {
  version: string; generatedAt: string;
  events: Array<PayloadSchema>;
  headers: Record<string, string>;
} {
  return {
    version: "1.0.0",
    generatedAt: new Date().toISOString(),
    headers: {
      "x-pluto-event": "<event name>",
      "x-pluto-delivery": "<delivery id, stable across retries>",
      "x-pluto-attempt": "<attempt number, 1..4>",
      "x-pluto-timestamp": "<ms since epoch>",
      "x-pluto-signature": "sha256=<hex hmac of raw body using webhook secret>",
    },
    events: ALL_EVENTS.map((e) => PAYLOAD_SCHEMAS[e]),
  };
}
