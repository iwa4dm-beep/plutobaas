// Compliance (GDPR): PII column tagging + auto-scan, DSAR export/erasure jobs,
// retention policies, immutable audit sealing.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

const piiBody = z.object({
  project_id: z.string().uuid(),
  schema_name: z.string().regex(SAFE_IDENT),
  table_name: z.string().regex(SAFE_IDENT),
  column_name: z.string().regex(SAFE_IDENT),
  category: z.enum(['email', 'phone', 'name', 'address', 'id_number', 'financial', 'health', 'ip', 'biometric', 'other']),
  masking: z.enum(['none', 'hash', 'partial', 'full']).default('none'),
});

const dsarBody = z.object({
  project_id: z.string().uuid(),
  subject_user_id: z.string().uuid(),
  kind: z.enum(['export', 'erasure']),
  notes: z.string().max(2000).optional(),
});

const retentionBody = z.object({
  project_id: z.string().uuid(),
  schema_name: z.string().regex(SAFE_IDENT),
  table_name: z.string().regex(SAFE_IDENT),
  ts_column: z.string().regex(SAFE_IDENT),
  keep_days: z.number().int().min(1).max(3650),
  strategy: z.enum(['delete', 'anonymize']).default('delete'),
  enabled: z.boolean().default(true),
});

// Heuristic column-name → PII category.
function guessCategory(col: string): string | null {
  const c = col.toLowerCase();
  if (/^(email|e_mail|email_address)$/.test(c)) return 'email';
  if (/(phone|mobile|msisdn)/.test(c)) return 'phone';
  if (/(first_name|last_name|full_name|display_name|surname|forename)/.test(c)) return 'name';
  if (/(address|street|city|zip|postal)/.test(c)) return 'address';
  if (/(ssn|nid|passport|national_id|tax_id|aadhaar)/.test(c)) return 'id_number';
  if (/(iban|bic|swift|card|cvv|account_number|routing)/.test(c)) return 'financial';
  if (/(diagnos|medical|health|allerg)/.test(c)) return 'health';
  if (/(ip_address|remote_addr|client_ip)/.test(c)) return 'ip';
  if (/(finger|face|iris|biometric)/.test(c)) return 'biometric';
  return null;
}

export async function complianceRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- PII column tags ----------
  app.get('/admin/v1/pii/columns', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`
      select * from admin.pii_columns where project_id = ${q.project_id}
      order by schema_name, table_name, column_name`;
  });

  app.post('/admin/v1/pii/columns', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = piiBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.pii_columns (project_id, schema_name, table_name, column_name, category, masking, detected_by)
      values (${body.project_id}, ${body.schema_name}, ${body.table_name}, ${body.column_name},
              ${body.category}, ${body.masking}, 'manual')
      on conflict (project_id, schema_name, table_name, column_name)
      do update set category = excluded.category, masking = excluded.masking
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'pii.tag', target: `${body.schema_name}.${body.table_name}.${body.column_name}` });
    reply.code(201).send(row);
  });

  app.delete('/admin/v1/pii/columns/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.pii_columns where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'pii.untag', target: id });
    reply.code(204).send();
  });

  // Heuristic scanner — walks information_schema, guesses categories, upserts as detected_by='scan'.
  app.post('/admin/v1/pii/scan', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      schemas: z.array(z.string().regex(SAFE_IDENT)).default(['public']),
    }).parse(req.body);
    const sql = getSql(cfg);
    const cols = await sql<any[]>`
      select table_schema, table_name, column_name
      from information_schema.columns
      where table_schema = any(${body.schemas as any})`;
    let found = 0;
    for (const c of cols) {
      const cat = guessCategory(c.column_name);
      if (!cat) continue;
      await sql`
        insert into admin.pii_columns (project_id, schema_name, table_name, column_name, category, detected_by)
        values (${body.project_id}, ${c.table_schema}, ${c.table_name}, ${c.column_name}, ${cat}, 'scan')
        on conflict (project_id, schema_name, table_name, column_name) do nothing`;
      found += 1;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: 'pii.scan', target: body.schemas.join(','), detail: { candidates: found } });
    return { scanned: cols.length, candidates: found };
  });

  // ---------- DSAR (export/erasure) ----------
  app.get('/admin/v1/dsar', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`
      select id, subject_user_id, kind, status, bundle_path, requested_at, fulfilled_at, notes
      from admin.dsar_requests where project_id = ${q.project_id}
      order by requested_at desc`;
  });

  app.post('/admin/v1/dsar', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = dsarBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.dsar_requests (project_id, subject_user_id, kind, requested_by, notes)
      values (${body.project_id}, ${body.subject_user_id}, ${body.kind}, ${actor.userId}, ${body.notes ?? null})
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: `dsar.${body.kind}.create`, target: body.subject_user_id });
    reply.code(201).send(row);
  });

  // Run one DSAR job (export bundle or erasure) synchronously.
  app.post('/admin/v1/dsar/:id/run', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const sql = getSql(cfg);
    const [dsar] = await sql<any[]>`select * from admin.dsar_requests where id = ${id}`;
    if (!dsar) { reply.code(404).send({ error: 'not_found' }); return; }
    await sql`update admin.dsar_requests set status = 'processing' where id = ${id}`;

    const pii = await sql<any[]>`select schema_name, table_name, column_name, category from admin.pii_columns where project_id = ${dsar.project_id}`;
    // Group columns by table. We look for a foreign-key-ish "user_id" column on those tables.
    const byTable = new Map<string, { cols: string[]; }>();
    for (const p of pii) {
      const k = `${p.schema_name}.${p.table_name}`;
      const rec = byTable.get(k) ?? { cols: [] };
      rec.cols.push(p.column_name);
      byTable.set(k, rec);
    }

    const bundle: Record<string, any[]> = {};
    let touched = 0;
    for (const [tbl, rec] of byTable) {
      const [sch, tab] = tbl.split('.');
      if (!SAFE_IDENT.test(sch) || !SAFE_IDENT.test(tab)) continue;
      // Detect a plausible user-id column
      const userCol = await sql<any[]>`
        select column_name from information_schema.columns
        where table_schema = ${sch} and table_name = ${tab}
          and column_name in ('user_id','owner_id','created_by','account_id') limit 1`;
      if (userCol.length === 0) continue;
      const uc = userCol[0].column_name;
      if (!SAFE_IDENT.test(uc)) continue;
      if (dsar.kind === 'export') {
        const rows = await sql.unsafe(
          `select * from ${sch}.${tab} where ${uc}::text = '${String(dsar.subject_user_id).replace(/'/g, "''")}'`,
        );
        bundle[tbl] = rows as any[];
        touched += (rows as any[]).length;
      } else {
        // erasure: anonymize PII columns per row; do not delete FK rows.
        const sets = rec.cols
          .filter((c) => SAFE_IDENT.test(c))
          .map((c) => `${c} = null`).join(', ');
        if (sets) {
          const r = await sql.unsafe(
            `update ${sch}.${tab} set ${sets} where ${uc}::text = '${String(dsar.subject_user_id).replace(/'/g, "''")}'`,
          );
          touched += (r as any).count ?? 0;
        }
      }
    }

    let path: string | null = null;
    if (dsar.kind === 'export') {
      path = `dsar/${dsar.project_id}/${dsar.id}.json`;
      // The bundle payload is stored under `notes` as JSON here (server-side storage/S3 wiring
      // can be layered on by consuming the returned payload via /storage). This keeps compliance
      // work atomic even before a storage bucket is provisioned.
      await sql`update admin.dsar_requests
        set status = 'ready', bundle_path = ${path},
            notes = ${JSON.stringify({ tables: touched, generated_at: new Date().toISOString(), bundle }).slice(0, 100000)},
            fulfilled_at = now()
        where id = ${id}`;
    } else {
      await sql`update admin.dsar_requests set status = 'delivered', fulfilled_at = now() where id = ${id}`;
    }
    await logAudit(cfg, { actor_id: actor.userId, action: `dsar.${dsar.kind}.run`, target: id, detail: { touched } });
    return { ok: true, touched, path };
  });

  // ---------- Retention policies ----------
  app.get('/admin/v1/retention', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return getSql(cfg)`select * from admin.retention_policies where project_id = ${q.project_id} order by schema_name, table_name`;
  });

  app.post('/admin/v1/retention', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = retentionBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.retention_policies
        (project_id, schema_name, table_name, ts_column, keep_days, strategy, enabled)
      values (${body.project_id}, ${body.schema_name}, ${body.table_name}, ${body.ts_column},
              ${body.keep_days}, ${body.strategy}, ${body.enabled})
      on conflict (project_id, schema_name, table_name)
      do update set ts_column = excluded.ts_column, keep_days = excluded.keep_days,
                    strategy = excluded.strategy, enabled = excluded.enabled
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'retention.upsert', target: `${body.schema_name}.${body.table_name}`, detail: body });
    reply.code(201).send(row);
  });

  app.delete('/admin/v1/retention/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`delete from admin.retention_policies where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'retention.delete', target: id });
    reply.code(204).send();
  });

  app.post('/admin/v1/retention/:id/run', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const sql = getSql(cfg);
    const [p] = await sql<any[]>`select * from admin.retention_policies where id = ${id}`;
    if (!p) { reply.code(404).send({ error: 'not_found' }); return; }
    if (!SAFE_IDENT.test(p.schema_name) || !SAFE_IDENT.test(p.table_name) || !SAFE_IDENT.test(p.ts_column)) {
      reply.code(400).send({ error: 'invalid_identifier' }); return;
    }
    let rows = 0;
    if (p.strategy === 'delete') {
      const r = await sql.unsafe(`delete from ${p.schema_name}.${p.table_name} where ${p.ts_column} < now() - interval '${Number(p.keep_days)} days'`);
      rows = (r as any).count ?? 0;
    } else {
      // Anonymize PII columns for aged rows.
      const pii = await sql<any[]>`select column_name from admin.pii_columns where project_id = ${p.project_id} and schema_name = ${p.schema_name} and table_name = ${p.table_name}`;
      const sets = pii.map((c) => SAFE_IDENT.test(c.column_name) ? `${c.column_name} = null` : '').filter(Boolean).join(', ');
      if (sets) {
        const r = await sql.unsafe(`update ${p.schema_name}.${p.table_name} set ${sets} where ${p.ts_column} < now() - interval '${Number(p.keep_days)} days'`);
        rows = (r as any).count ?? 0;
      }
    }
    await sql`update admin.retention_policies set last_run_at = now(), rows_last_run = ${rows} where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'retention.run', target: id, detail: { rows } });
    return { rows };
  });

  // ---------- Audit sealing (hash chain over admin.audit_log) ----------
  app.get('/admin/v1/audit-seals', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid().optional() }).parse(req.query);
    return getSql(cfg)`
      select id, from_id, to_id, row_count, chain_hash, sealed_at
      from admin.audit_seals
      where (${q.project_id ?? null}::uuid is null or project_id = ${q.project_id ?? null}::uuid)
      order by to_id desc limit 200`;
  });

  app.post('/admin/v1/audit-seals', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({ project_id: z.string().uuid().optional() }).parse(req.body ?? {});
    const sql = getSql(cfg);
    const [last] = await sql<any[]>`select to_id, chain_hash from admin.audit_seals
      where (${body.project_id ?? null}::uuid is null or project_id = ${body.project_id ?? null}::uuid)
      order by to_id desc limit 1`;
    const fromId = (last?.to_id ?? 0) + 1;
    const prevHash = last?.chain_hash ?? '0'.repeat(64);
    const rows = await sql<any[]>`
      select id, actor_id, action, target, detail, created_at
      from admin.audit_log
      where id >= ${fromId}
      order by id asc limit 5000`;
    if (rows.length === 0) return { sealed: 0, from_id: fromId, to_id: fromId - 1 };
    const hasher = createHash('sha256');
    hasher.update(prevHash);
    for (const r of rows) hasher.update(JSON.stringify(r));
    const chainHash = hasher.digest('hex');
    const toId = rows[rows.length - 1].id;
    const [seal] = await sql<any[]>`
      insert into admin.audit_seals (project_id, from_id, to_id, row_count, prev_hash, chain_hash, sealed_by)
      values (${body.project_id ?? null}, ${fromId}, ${toId}, ${rows.length}, ${prevHash}, ${chainHash}, ${actor.userId})
      returning id, from_id, to_id, row_count, chain_hash, sealed_at`;
    return seal;
  });

  // Verify chain integrity for a range of seals.
  app.get('/admin/v1/audit-seals/verify', async (req) => {
    await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const seals = await sql<any[]>`select * from admin.audit_seals order by to_id asc`;
    const issues: any[] = [];
    let prev = '0'.repeat(64);
    for (const s of seals) {
      if (s.prev_hash !== prev) issues.push({ seal: s.id, kind: 'chain_break' });
      const rows = await sql<any[]>`select id, actor_id, action, target, detail, created_at from admin.audit_log where id between ${s.from_id} and ${s.to_id} order by id asc`;
      const h = createHash('sha256'); h.update(prev);
      for (const r of rows) h.update(JSON.stringify(r));
      if (h.digest('hex') !== s.chain_hash) issues.push({ seal: s.id, kind: 'hash_mismatch' });
      prev = s.chain_hash;
    }
    return { seals: seals.length, issues };
  });
}
