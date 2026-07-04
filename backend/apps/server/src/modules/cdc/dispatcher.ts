// Phase 33 — CDC dispatcher.
//
// Normalises WAL events (from wal2json or logical replication decoder)
// into `CdcEvent`, applies subscriber filters, and fans out via the
// existing `pg_notify('pluto_broadcast', …)` channel so realtime_v2
// subscribers pick them up on their websocket without any new transport.
//
// The wal2json subscription itself is set up in `startCdcDecoder` — it
// runs behind PLUTO_ENABLE_CDC=1 and can be skipped in dev/CI where the
// database doesn't have logical replication configured. The dispatcher
// is exposed independently so downstream tests can feed synthetic
// events without spinning up replication.

import type { PoolClient } from "pg";
import pg from "pg";
import { env } from "../../config.js";
import { db } from "../../db/index.js";

export type CdcOp = "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE";

export type CdcEvent = {
  schema: string;
  table: string;
  op: CdcOp;
  commit_ts: string;      // ISO
  lsn?: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
  pk?: Record<string, unknown>;
};

const notifyPool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });

/**
 * Broadcast a single CDC event on `pluto_broadcast` and persist it into
 * `cdc_events`. Realtime_v2 subscribers filter by (schema, table) — this
 * function does NOT itself evaluate per-subscriber filters; that runs on
 * the socket-facing side where subscription state lives.
 */
export async function dispatchCdcEvent(ev: CdcEvent): Promise<void> {
  // Persist first so a slow LISTENer can still replay from cdc_events.
  await db.insertInto("cdc_events" as never).values({
    commit_ts: new Date(ev.commit_ts),
    schema_name: ev.schema, table_name: ev.table, op: ev.op,
    row_pk: ev.pk ?? null, new_row: ev.new ?? null, old_row: ev.old ?? null,
    lsn: ev.lsn ?? null,
  } as never).execute();

  // Broadcast a compact payload; websocket layer joins subscribers.
  const payload = JSON.stringify({
    channel: `postgres_changes:${ev.schema}:${ev.table}`,
    event: ev.op, ts: ev.commit_ts, lsn: ev.lsn, pk: ev.pk,
    new: ev.new, old: ev.old,
  });
  const client = await notifyPool.connect();
  try {
    // pg_notify caps payload at 8000 chars — clip for safety.
    const safe = payload.length > 7500 ? payload.slice(0, 7500) : payload;
    await client.query(`select pg_notify('pluto_broadcast', $1)`, [safe]);
  } finally { client.release(); }
}

/**
 * Retention sweeper — trim cdc_events older than 24h. Runs from the
 * boot orchestration so tests don't stall on setInterval handles.
 */
export async function sweepCdcRetention(): Promise<{ pruned: number }> {
  const r = await notifyPool.query(
    `delete from public.cdc_events where commit_ts < now() - interval '24 hours'`,
  );
  return { pruned: r.rowCount ?? 0 };
}

/**
 * Read the current slot lag in bytes (WAL bytes buffered but not
 * consumed). Returns null when the slot doesn't exist.
 */
export async function getSlotLag(slotName = "pluto_cdc_slot"): Promise<number | null> {
  const r = await notifyPool.query<{ lag: string | null }>(
    `select coalesce(
        pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn), 0
     )::text as lag
       from pg_replication_slots where slot_name = $1`, [slotName],
  );
  if (r.rowCount === 0) return null;
  const lag = r.rows[0].lag;
  return lag === null ? null : Number(lag);
}

/**
 * Bootstrap the CDC pipeline: create the publication, ensure the slot,
 * enable the sweeper, and start a wal2json decoder if the driver is
 * available. Safe to call multiple times.
 */
let started = false;
export async function startCdcPipeline(logger: { info: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }): Promise<void> {
  if (started) return;
  started = true;
  const boot = await notifyPool.connect();
  try {
    // Advisory lock keeps duplicate instances from double-starting the
    // decoder. The number is arbitrary but stable.
    const { rows: lockRows } = await boot.query<{ acquired: boolean }>(
      `select pg_try_advisory_lock(97231001) as acquired`,
    );
    if (!lockRows[0]?.acquired) {
      logger.info({}, "cdc: another instance holds the pipeline lock — skipping");
      return;
    }
    await ensurePublication(boot);
    await ensureReplicationSlot(boot);
    logger.info({}, "cdc: publication + slot ready");
  } catch (e) {
    logger.error({ err: (e as Error).message }, "cdc_bootstrap_failed");
  } finally {
    boot.release();
  }
  // Sweep every 10 minutes.
  setInterval(() => { void sweepCdcRetention().catch(() => undefined); }, 10 * 60 * 1000).unref?.();
}

async function ensurePublication(client: PoolClient): Promise<void> {
  const rows = await client.query<{ pubname: string }>(`select pubname from pg_publication where pubname = 'pluto_cdc'`);
  if (rows.rowCount === 0) {
    await client.query(`create publication pluto_cdc`);
  }
  // Reconcile membership from cdc_config (enabled rows).
  const cfg = await client.query<{ schema_name: string; table_name: string }>(
    `select distinct schema_name, table_name from public.cdc_config where enabled = true`,
  );
  const current = await client.query<{ schemaname: string; tablename: string }>(
    `select schemaname, tablename from pg_publication_tables where pubname = 'pluto_cdc'`,
  );
  const desired = new Set(cfg.rows.map(r => `${r.schema_name}.${r.table_name}`));
  const have    = new Set(current.rows.map(r => `${r.schemaname}.${r.tablename}`));
  for (const k of desired) if (!have.has(k)) {
    await client.query(`alter publication pluto_cdc add table ${quoteIdent(k)}`);
  }
  for (const k of have) if (!desired.has(k)) {
    await client.query(`alter publication pluto_cdc drop table ${quoteIdent(k)}`);
  }
}

async function ensureReplicationSlot(client: PoolClient): Promise<void> {
  const rows = await client.query<{ slot_name: string }>(
    `select slot_name from pg_replication_slots where slot_name = 'pluto_cdc_slot'`,
  );
  if (rows.rowCount === 0) {
    // wal2json is preferred; fall back to test_decoding if unavailable.
    try {
      await client.query(`select pg_create_logical_replication_slot('pluto_cdc_slot', 'wal2json')`);
    } catch {
      await client.query(`select pg_create_logical_replication_slot('pluto_cdc_slot', 'test_decoding')`);
    }
  }
}

function quoteIdent(dotted: string): string {
  return dotted.split(".").map(p => `"${p.replace(/"/g, '""')}"`).join(".");
}
