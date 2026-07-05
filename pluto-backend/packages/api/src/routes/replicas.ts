// Read replica registry + latency/routing hints. The backend can be pointed
// at replicas via the X-Pluto-Read-Preference header (best-effort routing —
// we return the chosen replica label so the client SDK can dispatch).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const replicaBody = z.object({
  project_id: z.string().uuid(),
  region: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  connection_url: z.string().min(10),
  weight: z.number().int().min(0).max(1000).default(100),
  enabled: z.boolean().default(true),
});

async function probeReplica(url: string): Promise<{ ok: boolean; lag_bytes?: number; lag_seconds?: number; err?: string }> {
  // Best-effort probe. Uses `postgres` dynamically so we don't add deps.
  try {
    const pg = await import('postgres');
    const client = (pg.default as any)(url, { max: 1, idle_timeout: 5, connect_timeout: 5 });
    try {
      const r = await client`
        select pg_is_in_recovery() as replica,
               coalesce(extract(epoch from now() - pg_last_xact_replay_timestamp()), 0)::float as lag_s,
               coalesce(pg_wal_lsn_diff(pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn()), 0)::bigint as lag_b`;
      return { ok: true, lag_seconds: Number(r[0]?.lag_s ?? 0), lag_bytes: Number(r[0]?.lag_b ?? 0) };
    } finally {
      await client.end({ timeout: 2 });
    }
  } catch (e: any) {
    return { ok: false, err: String(e.message ?? e) };
  }
}

export async function replicasRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/replicas', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`
      select id, region, label, weight, enabled, healthy, lag_bytes, lag_seconds, last_health_at, created_at
      from admin.read_replicas where project_id = ${q.project_id}
      order by region, label`;
  });

  app.post('/admin/v1/replicas', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = replicaBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.read_replicas (project_id, region, label, connection_url, weight, enabled)
      values (${body.project_id}, ${body.region}, ${body.label}, ${body.connection_url}, ${body.weight}, ${body.enabled})
      on conflict (project_id, label) do update
        set region = excluded.region, connection_url = excluded.connection_url,
            weight = excluded.weight, enabled = excluded.enabled
      returning id, region, label, weight, enabled, created_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'replica.upsert', target: body.label, detail: { region: body.region } });
    reply.code(201).send(row);
  });

  app.delete('/admin/v1/replicas/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.read_replicas where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'replica.delete', target: id });
    reply.code(204).send();
  });

  // Probe one replica and update health/lag columns.
  app.post('/admin/v1/replicas/:id/probe', async (req, reply) => {
    await requireAuth(req, cfg);
    const { id } = req.params as any;
    const sql = getSql(cfg);
    const [r] = await sql<any[]>`select connection_url from admin.read_replicas where id = ${id}`;
    if (!r) { reply.code(404).send({ error: 'not_found' }); return; }
    const res = await probeReplica(r.connection_url);
    await sql`update admin.read_replicas
      set healthy = ${res.ok}, lag_bytes = ${res.lag_bytes ?? null},
          lag_seconds = ${res.lag_seconds ?? null}, last_health_at = now()
      where id = ${id}`;
    return res;
  });

  // Probe all replicas of a project (batch).
  app.post('/admin/v1/replicas/probe-all', async (req) => {
    await requireAuth(req, cfg);
    const body = z.object({ project_id: z.string().uuid() }).parse(req.body);
    const sql = getSql(cfg);
    const rows = await sql<any[]>`select id, connection_url from admin.read_replicas where project_id = ${body.project_id} and enabled = true`;
    const out: any[] = [];
    for (const r of rows) {
      const res = await probeReplica(r.connection_url);
      await sql`update admin.read_replicas
        set healthy = ${res.ok}, lag_bytes = ${res.lag_bytes ?? null},
            lag_seconds = ${res.lag_seconds ?? null}, last_health_at = now()
        where id = ${r.id}`;
      out.push({ id: r.id, ...res });
    }
    return { probed: rows.length, results: out };
  });

  // Return a routing hint: given a preference (region / lag_max), pick a replica.
  // Body: { project_id, region?, max_lag_seconds? }
  app.post('/admin/v1/replicas/route', async (req) => {
    await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      region: z.string().optional(),
      max_lag_seconds: z.number().nonnegative().optional(),
    }).parse(req.body);
    const sql = getSql(cfg);
    const rows = await sql<any[]>`
      select id, region, label, weight, lag_seconds, healthy
      from admin.read_replicas
      where project_id = ${body.project_id} and enabled = true and healthy is not false
        and (${body.region ?? null}::text is null or region = ${body.region ?? null})
        and (${body.max_lag_seconds ?? null}::float is null or coalesce(lag_seconds,0) <= ${body.max_lag_seconds ?? null})`;
    if (rows.length === 0) return { picked: null, reason: 'no_healthy_replica' };
    // Weighted random.
    const total = rows.reduce((s, r) => s + Math.max(0, r.weight || 0), 0) || 1;
    let x = Math.random() * total;
    for (const r of rows) { x -= (r.weight || 0); if (x <= 0) return { picked: r, from: rows.length }; }
    return { picked: rows[0], from: rows.length };
  });
}
