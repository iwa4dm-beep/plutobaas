import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { runFunction, type FnRequest } from '../functions/runner.js';
import { fnInvocations, fnDuration } from '../observability/metrics.js';

const SLUG = /^[a-z][a-z0-9-]{0,62}$/;

const createBody = z.object({
  project_id: z.string().uuid(),
  slug: z.string().regex(SLUG),
  code: z.string().min(1).max(200_000),
  memory_mb: z.number().int().min(32).max(1024).optional(),
  timeout_ms: z.number().int().min(100).max(60_000).optional(),
  env: z.record(z.string()).optional(),
  verify_jwt: z.boolean().optional(),
});

const updateBody = createBody.partial().omit({ project_id: true, slug: true });

async function requireAuth(req: FastifyRequest): Promise<any> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  return (req as any).jwtVerify();
}

async function optionalAuth(req: FastifyRequest): Promise<any | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  try { return await (req as any).jwtVerify(); } catch { return null; }
}

export async function functionsRoutes(app: FastifyInstance, cfg: Config) {
  // --- Management: list ---
  app.get<{ Querystring: { project_id?: string } }>('/functions/v1', async (req, reply) => {
    const claims = await requireAuth(req);
    const sql = getSql(cfg);
    const rows = req.query.project_id
      ? await sql`select id, slug, memory_mb, timeout_ms, verify_jwt, created_at, updated_at
                  from admin.functions where project_id = ${req.query.project_id}
                  order by slug`
      : await sql`select id, project_id, slug, memory_mb, timeout_ms, verify_jwt, created_at
                  from admin.functions
                  where project_id in (select project_id from admin.project_members where user_id = ${claims.sub})
                  order by created_at desc`;
    return reply.send(rows);
  });

  // --- Create ---
  app.post('/functions/v1', async (req, reply) => {
    const claims = await requireAuth(req);
    const body = createBody.parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into admin.functions (project_id, slug, code, memory_mb, timeout_ms, env, verify_jwt, created_by)
      values (${body.project_id}, ${body.slug}, ${body.code},
              ${body.memory_mb ?? 128}, ${body.timeout_ms ?? 10000},
              ${sql.json(body.env ?? {})}, ${body.verify_jwt ?? true}, ${claims.sub})
      returning id, slug, memory_mb, timeout_ms, verify_jwt, created_at`;
    return reply.code(201).send(row);
  });

  // --- Get source ---
  app.get<{ Params: { id: string } }>('/functions/v1/:id', async (req, reply) => {
    await requireAuth(req);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.functions where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return reply.send(row);
  });

  // --- Update ---
  app.patch<{ Params: { id: string } }>('/functions/v1/:id', async (req, reply) => {
    await requireAuth(req);
    const body = updateBody.parse(req.body);
    const sql = getSql(cfg);
    const patch: Record<string, any> = { updated_at: new Date() };
    if (body.code !== undefined) patch.code = body.code;
    if (body.memory_mb !== undefined) patch.memory_mb = body.memory_mb;
    if (body.timeout_ms !== undefined) patch.timeout_ms = body.timeout_ms;
    if (body.env !== undefined) patch.env = sql.json(body.env);
    if (body.verify_jwt !== undefined) patch.verify_jwt = body.verify_jwt;
    const [row] = await sql<any[]>`update admin.functions set ${sql(patch)} where id = ${req.params.id} returning id, slug, updated_at`;
    if (!row) return reply.code(404).send({ error: 'not found' });
    return reply.send(row);
  });

  // --- Delete ---
  app.delete<{ Params: { id: string } }>('/functions/v1/:id', async (req, reply) => {
    await requireAuth(req);
    const sql = getSql(cfg);
    await sql`delete from admin.functions where id = ${req.params.id}`;
    return reply.send({ message: 'Deleted' });
  });

  // --- Invoke by slug ---
  const invoke = async (req: FastifyRequest, reply: FastifyReply, projectSlug: string | null, fnSlug: string) => {
    if (!SLUG.test(fnSlug)) return reply.code(400).send({ error: 'invalid slug' });
    const sql = getSql(cfg);
    const rows = projectSlug
      ? await sql<any[]>`select f.* from admin.functions f
          join admin.projects p on p.id = f.project_id
          where p.slug = ${projectSlug} and f.slug = ${fnSlug} limit 1`
      : await sql<any[]>`select * from admin.functions where slug = ${fnSlug} order by created_at desc limit 1`;
    const fn = rows[0];
    if (!fn) return reply.code(404).send({ error: 'function not found' });

    let claims: any = null;
    if (fn.verify_jwt) {
      try { claims = await (req as any).jwtVerify(); }
      catch { return reply.code(401).send({ error: 'unauthorized' }); }
    } else {
      claims = await optionalAuth(req);
    }

    // Read raw body (allowed content types)
    const body = req.body == null ? '' :
      typeof req.body === 'string' ? req.body :
      Buffer.isBuffer(req.body) ? req.body.toString('utf8') :
      JSON.stringify(req.body);

    const url = `http://fn.local${req.url.startsWith('/') ? req.url : '/' + req.url}`;
    const fnReq: FnRequest = {
      method: req.method,
      url,
      headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v ?? '')])
      ),
      body,
      claims,
    };

    const t0 = process.hrtime.bigint();
    const result = await runFunction(fn.code, fnReq, fn.env ?? {}, fn.timeout_ms);
    const seconds = Number(process.hrtime.bigint() - t0) / 1e9;
    fnDuration.observe({ slug: fnSlug }, seconds);
    fnInvocations.inc({ slug: fnSlug, result: result.error ? 'fail' : 'ok' });

    for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
    reply.header('x-pluto-fn-duration-ms', String(result.duration_ms));
    if (result.logs.length && process.env.NODE_ENV !== 'production') {
      reply.header('x-pluto-fn-logs', encodeURIComponent(result.logs.slice(0, 20).join('\n')));
    }
    return reply.code(result.status).send(result.body);
  };

  // Global namespace invoke: /functions/v1/invoke/:slug
  app.all<{ Params: { slug: string } }>('/functions/v1/invoke/:slug', (req, reply) => invoke(req, reply, null, req.params.slug));
  // Project-scoped: /functions/v1/:projectSlug/:fnSlug  (POST/GET/etc)
  app.all<{ Params: { projectSlug: string; fnSlug: string } }>(
    '/functions/v1/p/:projectSlug/:fnSlug',
    (req, reply) => invoke(req, reply, req.params.projectSlug, req.params.fnSlug),
  );
}
