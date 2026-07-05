import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

/**
 * PostgREST-compatible Data API.
 *
 * Supports:
 *   GET    /rest/v1/:table      list rows with filters, select, order, limit, offset, range
 *   POST   /rest/v1/:table      insert (single row or array); Prefer: return=representation | resolution=merge-duplicates
 *   PATCH  /rest/v1/:table      update rows matching filters
 *   DELETE /rest/v1/:table      delete rows matching filters
 *   POST   /rest/v1/rpc/:fn     call a Postgres function
 *
 * Filter grammar (query string):
 *   ?col=eq.value        col = value
 *   ?col=neq.value       col <> value
 *   ?col=gt.5            col > 5
 *   ?col=gte.5           col >= 5
 *   ?col=lt.5 / lte.5    col < / <= 5
 *   ?col=like.%foo%      col LIKE '%foo%'
 *   ?col=ilike.%foo%     col ILIKE '%foo%'
 *   ?col=in.(a,b,c)      col IN (a,b,c)
 *   ?col=is.null|true|false
 *   ?col=not.eq.value    negation prefix
 *   ?select=col1,col2    projection
 *   ?order=col.desc,col2.asc
 *   ?limit=10&offset=20
 *
 * RLS: request runs as role `anon` or `authenticated` (depending on bearer),
 * with `request.jwt.claims` set as a GUC so Postgres RLS policies can read auth.uid().
 */

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function safeIdent(name: string): string {
  if (!SAFE_IDENT.test(name)) throw new Error(`Invalid identifier: ${name}`);
  return `"${name}"`;
}

interface Filter {
  col: string;
  op: string;
  value: any;
  negate: boolean;
}

const OPS: Record<string, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
  like: 'LIKE', ilike: 'ILIKE',
};

function parseFilters(query: Record<string, any>): { filters: Filter[]; select?: string; order?: string; limit?: number; offset?: number } {
  const reserved = new Set(['select', 'order', 'limit', 'offset']);
  const filters: Filter[] = [];
  for (const [key, rawVal] of Object.entries(query)) {
    if (reserved.has(key)) continue;
    if (!SAFE_IDENT.test(key)) throw new Error(`Invalid column: ${key}`);
    const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
    for (const v of vals) {
      let s = String(v);
      let negate = false;
      if (s.startsWith('not.')) { negate = true; s = s.slice(4); }
      const dot = s.indexOf('.');
      if (dot < 0) throw new Error(`Invalid filter for ${key}: ${s}`);
      const op = s.slice(0, dot);
      const value = s.slice(dot + 1);
      filters.push({ col: key, op, value, negate });
    }
  }
  return {
    filters,
    select: query.select ? String(query.select) : undefined,
    order: query.order ? String(query.order) : undefined,
    limit: query.limit != null ? Number(query.limit) : undefined,
    offset: query.offset != null ? Number(query.offset) : undefined,
  };
}

function buildWhere(filters: Filter[]): { sql: string; params: any[] } {
  if (!filters.length) return { sql: '', params: [] };
  const parts: string[] = [];
  const params: any[] = [];
  for (const f of filters) {
    const col = safeIdent(f.col);
    let clause: string;
    if (f.op === 'is') {
      const v = f.value.toLowerCase();
      if (v === 'null') clause = `${col} IS NULL`;
      else if (v === 'true') clause = `${col} IS TRUE`;
      else if (v === 'false') clause = `${col} IS FALSE`;
      else throw new Error(`is.<${f.value}> not supported`);
    } else if (f.op === 'in') {
      const raw = f.value.replace(/^\(|\)$/g, '').split(',');
      const placeholders = raw.map((_, i) => `$${params.length + i + 1}`).join(',');
      params.push(...raw);
      clause = `${col} IN (${placeholders})`;
    } else if (OPS[f.op]) {
      params.push(f.value);
      clause = `${col} ${OPS[f.op]} $${params.length}`;
    } else {
      throw new Error(`Unknown operator: ${f.op}`);
    }
    if (f.negate) clause = `NOT (${clause})`;
    parts.push(clause);
  }
  return { sql: 'WHERE ' + parts.join(' AND '), params };
}

function buildSelect(select?: string): string {
  if (!select || select === '*') return '*';
  return select.split(',').map((s) => safeIdent(s.trim())).join(', ');
}

function buildOrder(order?: string): string {
  if (!order) return '';
  const parts = order.split(',').map((s) => {
    const [col, dir = 'asc'] = s.trim().split('.');
    const d = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    return `${safeIdent(col)} ${d}`;
  });
  return 'ORDER BY ' + parts.join(', ');
}

async function resolveClaims(app: FastifyInstance, req: FastifyRequest): Promise<{ role: string; claims: any }> {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) {
    return { role: 'anon', claims: { role: 'anon' } };
  }
  try {
    const claims = await app.jwt.verify<any>(h.slice(7));
    return { role: claims.role || 'authenticated', claims };
  } catch {
    return { role: 'anon', claims: { role: 'anon' } };
  }
}

async function runAs(
  app: FastifyInstance,
  cfg: Config,
  req: FastifyRequest,
  fn: (client: any) => Promise<any>,
) {
  const sql = getSql(cfg);
  const { role, claims } = await resolveClaims(app, req);
  // Enforce role & JWT claims for RLS via transaction-scoped GUCs.
  return await sql.begin(async (tx: any) => {
    // service_role should not be reachable via public bearer path; guard hard
    const safeRole = role === 'service_role' ? 'authenticated' : role;
    await tx.unsafe(`SET LOCAL ROLE ${safeIdent(safeRole).replace(/"/g, '')}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return fn(tx);
  });
}

function parsePrefer(req: FastifyRequest): { return: string; resolution?: string } {
  const raw = String(req.headers['prefer'] || '');
  const out: any = { return: 'representation' };
  for (const p of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = p.split('=');
    out[k] = v;
  }
  return out;
}

export async function restRoutes(app: FastifyInstance, cfg: Config) {
  // --- GET /rest/v1/:table ---
  app.get('/rest/v1/:table', async (req: any, reply: FastifyReply) => {
    try {
      const table = safeIdent(req.params.table);
      const q = parseFilters(req.query || {});
      const where = buildWhere(q.filters);
      const orderBy = buildOrder(q.order);
      const limit = q.limit != null ? `LIMIT ${Math.max(0, Math.min(q.limit, 10000))}` : '';
      const offset = q.offset != null ? `OFFSET ${Math.max(0, q.offset)}` : '';
      const sqlText = `SELECT ${buildSelect(q.select)} FROM public.${table} ${where.sql} ${orderBy} ${limit} ${offset}`.trim();

      const rows = await runAs(app, cfg, req, (tx) => tx.unsafe(sqlText, where.params));

      // Content-Range like PostgREST when a range header was sent
      const range = req.headers.range;
      if (range) reply.header('content-range', `${q.offset ?? 0}-${(q.offset ?? 0) + rows.length - 1}/*`);
      return reply.send(rows);
    } catch (e: any) {
      return reply.code(400).send({ error: 'bad_request', message: e.message });
    }
  });

  // --- POST /rest/v1/:table (insert / upsert) ---
  app.post('/rest/v1/:table', async (req: any, reply: FastifyReply) => {
    try {
      const table = safeIdent(req.params.table);
      const prefer = parsePrefer(req);
      const body = req.body;
      const rows: any[] = Array.isArray(body) ? body : [body];
      if (!rows.length) return reply.code(400).send({ error: 'empty_body' });

      const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      cols.forEach((c) => { if (!SAFE_IDENT.test(c)) throw new Error(`Invalid column: ${c}`); });
      const colList = cols.map(safeIdent).join(', ');

      const params: any[] = [];
      const values = rows
        .map((r) => {
          const ph = cols.map((c) => {
            params.push(r[c] === undefined ? null : r[c]);
            return `$${params.length}`;
          });
          return `(${ph.join(', ')})`;
        })
        .join(', ');

      let sqlText = `INSERT INTO public.${table} (${colList}) VALUES ${values}`;
      if (prefer.resolution === 'merge-duplicates') {
        const conflictTarget = String(req.query.on_conflict || cols[0]);
        const targetCols = conflictTarget.split(',').map((c) => safeIdent(c.trim())).join(', ');
        const updates = cols.filter((c) => !conflictTarget.split(',').includes(c))
          .map((c) => `${safeIdent(c)} = EXCLUDED.${safeIdent(c)}`).join(', ');
        sqlText += ` ON CONFLICT (${targetCols}) DO UPDATE SET ${updates || safeIdent(cols[0]) + ' = EXCLUDED.' + safeIdent(cols[0])}`;
      }
      if (prefer.return !== 'minimal') sqlText += ' RETURNING *';

      const result = await runAs(app, cfg, req, (tx) => tx.unsafe(sqlText, params));
      return reply.code(201).send(prefer.return === 'minimal' ? null : result);
    } catch (e: any) {
      return reply.code(400).send({ error: 'bad_request', message: e.message });
    }
  });

  // --- PATCH /rest/v1/:table ---
  app.patch('/rest/v1/:table', async (req: any, reply: FastifyReply) => {
    try {
      const table = safeIdent(req.params.table);
      const q = parseFilters(req.query || {});
      const where = buildWhere(q.filters);
      const body = req.body || {};
      const cols = Object.keys(body);
      if (!cols.length) return reply.code(400).send({ error: 'empty_body' });
      cols.forEach((c) => { if (!SAFE_IDENT.test(c)) throw new Error(`Invalid column: ${c}`); });

      const params: any[] = [];
      const setClause = cols.map((c) => {
        params.push(body[c]);
        return `${safeIdent(c)} = $${params.length}`;
      }).join(', ');
      const whereParams = where.params.map((v) => { params.push(v); return `$${params.length}`; });
      const rewrittenWhere = where.sql.replace(/\$\d+/g, () => whereParams.shift() as string);

      const prefer = parsePrefer(req);
      const returning = prefer.return === 'minimal' ? '' : 'RETURNING *';
      const sqlText = `UPDATE public.${table} SET ${setClause} ${rewrittenWhere} ${returning}`.trim();

      const result = await runAs(app, cfg, req, (tx) => tx.unsafe(sqlText, params));
      return reply.send(prefer.return === 'minimal' ? null : result);
    } catch (e: any) {
      return reply.code(400).send({ error: 'bad_request', message: e.message });
    }
  });

  // --- DELETE /rest/v1/:table ---
  app.delete('/rest/v1/:table', async (req: any, reply: FastifyReply) => {
    try {
      const table = safeIdent(req.params.table);
      const q = parseFilters(req.query || {});
      const where = buildWhere(q.filters);
      if (!where.sql) return reply.code(400).send({ error: 'refused', message: 'DELETE without filters refused' });
      const prefer = parsePrefer(req);
      const returning = prefer.return === 'minimal' ? '' : 'RETURNING *';
      const sqlText = `DELETE FROM public.${table} ${where.sql} ${returning}`.trim();

      const result = await runAs(app, cfg, req, (tx) => tx.unsafe(sqlText, where.params));
      return reply.send(prefer.return === 'minimal' ? null : result);
    } catch (e: any) {
      return reply.code(400).send({ error: 'bad_request', message: e.message });
    }
  });

  // --- POST /rest/v1/rpc/:fn ---
  app.post('/rest/v1/rpc/:fn', async (req: any, reply: FastifyReply) => {
    try {
      const fn = safeIdent(req.params.fn);
      const args = (req.body || {}) as Record<string, any>;
      const keys = Object.keys(args);
      const params: any[] = [];
      const named = keys.map((k) => {
        if (!SAFE_IDENT.test(k)) throw new Error(`Invalid arg name: ${k}`);
        params.push(args[k]);
        return `${k} => $${params.length}`;
      }).join(', ');
      const sqlText = `SELECT public.${fn}(${named}) AS result`;

      const rows = await runAs(app, cfg, req, (tx) => tx.unsafe(sqlText, params));
      return reply.send(rows.length === 1 ? rows[0].result : rows.map((r: any) => r.result));
    } catch (e: any) {
      return reply.code(400).send({ error: 'bad_request', message: e.message });
    }
  });
}
