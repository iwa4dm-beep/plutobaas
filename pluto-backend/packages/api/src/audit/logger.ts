import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

// Loose shape so routes can pass extra fields (target, detail, etc.) without
// TS2353 excess-property errors. Runtime only reads the columns below.
export type AuditRow = {
  actor_id?: string | null;
  project_id?: string | null;
  action: string;
  resource_type?: string;
  resource_id?: string | null;
  params?: Record<string, unknown> | null;
  result?: 'ok' | 'error' | 'blocked';
  duration_ms?: number | null;
  error_message?: string | null;
  [key: string]: unknown;
};

export async function logAudit(cfg: Config, row: AuditRow): Promise<void> {
  try {
    const sql = getSql(cfg);
    await sql`
      insert into admin.audit_log
        (actor_id, project_id, action, resource_type, resource_id, params, result, duration_ms, error_message)
      values
        (${row.actor_id}, ${row.project_id}, ${row.action}, ${row.resource_type},
         ${row.resource_id ?? null}, ${sql.json(row.params ?? {})},
         ${row.result}, ${row.duration_ms ?? null}, ${row.error_message ?? null})`;
  } catch {
    // Never let audit failures break the request.
  }
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = process.hrtime.bigint();
  const result = await fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { result, ms: Math.round(ms) };
}
