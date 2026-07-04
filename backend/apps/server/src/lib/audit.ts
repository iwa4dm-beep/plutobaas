// Audit trail + realtime system events.
//
// Every privileged dashboard action calls `audit(...)`. That writes a
// row to `public.audit_events` and simultaneously broadcasts a
// `system:audit` event over the Pluto realtime channel so dashboards
// can react without polling.
//
// `emit(channel, event, payload)` is a plain broadcast helper — used by
// the migration runner to stream per-step progress on
// `system:migrations`.

import type { FastifyRequest } from "fastify";
import pg from "pg";
import { env } from "../config.js";
import { db } from "../db/index.js";

const notifier = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });

export type AuditStatus = "ok" | "error" | "dry_run" | "warn";

export type AuditInput = {
  action: string;
  target?: string | null;
  /** Back-compat alias for `target` used by newer plugins (auth_v3 etc.). */
  target_id?: string | null;
  status?: AuditStatus;
  metadata?: Record<string, unknown>;
};

async function broadcast(channel: string, event: string, payload: unknown) {
  await notifier.query("select pg_notify('pluto_broadcast', $1)", [
    JSON.stringify({ channel, event, payload, ts: new Date().toISOString() }),
  ]).catch(() => { /* best effort */ });
}

export async function audit(req: FastifyRequest | null, input: AuditInput) {
  const actor = req?.auth?.user ?? null;
  const ip = req?.ip ?? null;
  const ua = (req?.headers?.["user-agent"] as string | undefined) ?? null;
  const row = {
    actor_id: actor?.sub ?? null,
    actor_email: actor?.email ?? null,
    actor_role: req?.auth?.apiKey === "service_role" ? (actor?.role ?? "service_role") : (actor?.role ?? "anon"),
    action: input.action,
    target: input.target ?? null,
    status: input.status ?? "ok",
    metadata: input.metadata ?? {},
    ip,
    user_agent: ua,
  };
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insertInto("audit_events" as never).values(row as any).execute();
  } catch { /* never let audit failures break the action */ }
  await broadcast("system:audit", input.action, { ...row, ts: new Date().toISOString() });
}

export async function emit(channel: string, event: string, payload: unknown) {
  await broadcast(channel, event, payload);
}

// Compat alias — earlier phases imported this name.
export const logAudit = audit;
