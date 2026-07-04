// Phase 44 — DB Webhook dispatcher.
//
// - `enqueueWebhookEvent()` looks up all enabled webhooks matching
//   (schema, table, event_type) and inserts a pending delivery row.
// - `dispatchDueDeliveries()` picks up pending rows past next_retry_at,
//   POSTs to the target URL with an HMAC-SHA256 signature header, and
//   schedules the next attempt with exponential backoff (2^n seconds,
//   capped at 5 min) up to max_retries.

import { createHmac } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { db } from "../db/index.js";

export type WebhookEvent = "INSERT" | "UPDATE" | "DELETE";

export async function enqueueWebhookEvent(input: {
  schema: string; table: string; event: WebhookEvent;
  payload: Record<string, unknown>;
}): Promise<number> {
  const hooks = await db.selectFrom("db_webhooks" as never)
    .selectAll()
    .where("enabled" as never, "=", true as never)
    .where("schema_name" as never, "=", input.schema as never)
    .where("table_name" as never, "=", input.table as never)
    .execute() as unknown as Array<{ id: string; events: string[] }>;

  const matched = hooks.filter(h => (h.events ?? []).includes(input.event));
  if (matched.length === 0) return 0;

  await db.insertInto("db_webhook_deliveries" as never).values(
    matched.map(h => ({
      webhook_id: h.id, event_type: input.event, payload: input.payload,
      status: "pending", next_retry_at: new Date(),
    })) as never
  ).execute();
  return matched.length;
}

function backoffMs(attempt: number): number {
  return Math.min(300_000, Math.pow(2, attempt) * 1000);
}

export async function dispatchDueDeliveries(log?: FastifyBaseLogger, limit = 25): Promise<{
  processed: number; sent: number; failed: number;
}> {
  const now = new Date();
  const due = await db.selectFrom("db_webhook_deliveries" as never)
    .selectAll()
    .where("status" as never, "=", "pending" as never)
    .where("next_retry_at" as never, "<=", now as never)
    .orderBy("id" as never, "asc")
    .limit(limit)
    .execute() as unknown as Array<{
      id: number; webhook_id: string; event_type: string;
      payload: Record<string, unknown>; attempt: number;
    }>;

  let sent = 0, failed = 0;
  for (const d of due) {
    const hook = await db.selectFrom("db_webhooks" as never).selectAll()
      .where("id" as never, "=", d.webhook_id as never)
      .executeTakeFirst() as unknown as {
        url: string; secret: string; headers: Record<string, string>;
        max_retries: number; timeout_ms: number;
      } | undefined;
    if (!hook) {
      await db.updateTable("db_webhook_deliveries" as never)
        .set({ status: "dead", error_message: "webhook_missing" } as never)
        .where("id" as never, "=", d.id as never).execute();
      continue;
    }

    const body = JSON.stringify({
      event: d.event_type, payload: d.payload,
      delivery_id: d.id, attempt: d.attempt + 1,
    });
    const sig = createHmac("sha256", hook.secret).update(body).digest("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), hook.timeout_ms);

    try {
      const res = await fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-pluto-signature": `sha256=${sig}`,
          "x-pluto-event": d.event_type,
          "x-pluto-delivery": String(d.id),
          ...hook.headers,
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text().catch(() => "");
      if (res.ok) {
        await db.updateTable("db_webhook_deliveries" as never).set({
          status: "sent", http_status: res.status,
          response_body: text.slice(0, 4096), delivered_at: new Date(),
          attempt: d.attempt + 1,
        } as never).where("id" as never, "=", d.id as never).execute();
        sent++;
      } else {
        await scheduleRetry(d, hook.max_retries, `http_${res.status}`, text.slice(0, 4096), res.status);
        failed++;
      }
    } catch (e) {
      clearTimeout(timer);
      await scheduleRetry(d, hook.max_retries, (e as Error).message, null, null);
      failed++;
    }
  }
  if (due.length) log?.info({ processed: due.length, sent, failed }, "webhook dispatcher tick");
  return { processed: due.length, sent, failed };
}

async function scheduleRetry(
  d: { id: number; attempt: number },
  maxRetries: number,
  error: string,
  responseBody: string | null,
  httpStatus: number | null,
): Promise<void> {
  const next = d.attempt + 1;
  const isDead = next >= maxRetries;
  await db.updateTable("db_webhook_deliveries" as never).set({
    status: isDead ? "dead" : "pending",
    attempt: next,
    http_status: httpStatus,
    response_body: responseBody,
    error_message: error,
    next_retry_at: isDead ? null : new Date(Date.now() + backoffMs(next)),
  } as never).where("id" as never, "=", d.id as never).execute();
}

let sweeperTimer: NodeJS.Timeout | null = null;
export function startWebhookSweeper(log: FastifyBaseLogger, intervalMs = 5000): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    dispatchDueDeliveries(log).catch(e => log.warn({ err: e }, "webhook sweeper failed"));
  }, intervalMs);
}
