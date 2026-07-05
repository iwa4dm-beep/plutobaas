import postgres from 'postgres';
import type { Config } from '../config.js';

let _sql: ReturnType<typeof postgres> | null = null;

// Return type intentionally `any` — postgres.js template-literal typings are
// too strict for our dynamic jsonb / bigint / object parameters and cause
// TS1320 / TS2345 / TS2769 across the codebase. Runtime behavior is unchanged.
export function getSql(cfg: Config): any {
  if (!_sql) {
    _sql = postgres(cfg.DATABASE_URL, {
      max: 20,
      idle_timeout: 30,
      connect_timeout: 10,
    });
  }
  return _sql;
}

export async function pingDb(cfg: Config): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const sql = getSql(cfg);
    await sql`select 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e: any) {
    return { ok: false, latencyMs: Date.now() - start, error: e.message };
  }
}
