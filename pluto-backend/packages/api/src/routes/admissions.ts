// Dedicated Admissions search endpoint for the dashboard global search
// (⌘K palette). Kept off the generic /rest/v1/ path so the query surface
// is fixed, the WHERE clause is safe against SQL injection (parameterized),
// and results are projected down to just the columns the UI needs.
//
// GET /admissions/v1/search?q=<text>&limit=<n>
//   q     — required, min 2 chars, matches student_name / mobile /
//           father_name / mother_name / class_applying_for / id (ilike)
//   limit — optional, 1..50, default 8
//
// Response: { ok, count, results: [{id, student_name, mobile,
//             class_applying_for, father_name, created_at}] }
//
// Auth: reuses the same JWT verification as the Data API. Anonymous
// callers get 401 — searching admissions is not a public surface.
// RLS still applies because we run the query as `authenticated` with
// pluto.user_id / request.jwt.claims set (same pattern as rest.ts).

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getSql } from '../db/pool.js';
import { resolvePgRole } from './rest-role.js';
import type { Config } from '../config.js';

const SEARCH_COLUMNS = [
  'id',
  'student_name',
  'mobile',
  'class_applying_for',
  'father_name',
  'created_at',
] as const;

async function resolveClaims(app: FastifyInstance, req: FastifyRequest) {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) return null;
  try {
    return await app.jwt.verify<any>(h.slice(7));
  } catch {
    return null;
  }
}

export async function admissionsRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admissions/v1/search', async (req: FastifyRequest, reply: FastifyReply) => {
    const claims = await resolveClaims(app, req);
    if (!claims) {
      return reply.code(401).send({ error: 'unauthorized', message: 'bearer token required to search admissions' });
    }

    const raw = (req.query as any) || {};
    const q = typeof raw.q === 'string' ? raw.q.trim() : '';
    const limitRaw = Number.parseInt(String(raw.limit ?? '8'), 10);
    const limit = Math.max(1, Math.min(50, Number.isFinite(limitRaw) ? limitRaw : 8));

    if (q.length < 2) {
      return reply.code(400).send({
        error: 'bad_request',
        message: 'q must be at least 2 characters',
        example: '/admissions/v1/search?q=rah&limit=8',
      });
    }

    const { pgRole } = resolvePgRole(claims.role);
    const userId = typeof claims.sub === 'string' ? claims.sub : '';
    const appRole = typeof claims.role === 'string' ? claims.role : 'authenticated';
    const sql = getSql(cfg);
    const like = `%${q}%`;
    const cols = SEARCH_COLUMNS.map((c) => `"${c}"`).join(', ');

    try {
      const rows = await sql.begin(async (tx: any) => {
        await tx.unsafe(`SET LOCAL ROLE ${pgRole}`);
        await tx`SELECT set_config('pluto.user_id', ${userId}, true)`;
        await tx`SELECT set_config('pluto.role', ${appRole}, true)`;
        await tx`SELECT set_config('pluto.jwt', ${JSON.stringify(claims)}, true)`;
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        // Parameterized ilike across every user-visible identifier column.
        // id is uuid → cast to text for ilike matching on partial ids.
        return await tx.unsafe(
          `select ${cols}
             from public.admissions
            where student_name        ilike $1
               or mobile              ilike $1
               or father_name         ilike $1
               or mother_name         ilike $1
               or class_applying_for  ilike $1
               or id::text            ilike $1
            order by created_at desc
            limit ${limit}`,
          [like],
        );
      });

      return reply.send({ ok: true, count: rows.length, results: rows });
    } catch (e: any) {
      const msg = e?.message || String(e);
      const code = e?.code;
      req.log.warn({ url: req.url, q, code, msg }, 'admissions.search.error');
      if (code === '42P01' || /relation .*admissions.* does not exist/i.test(msg)) {
        return reply.code(503).send({
          error: 'not_ready',
          code: '42P01',
          message: 'public.admissions table not yet migrated — run deploy/run-migrator.sh',
        });
      }
      if (code === '42501' || /row-level security/i.test(msg)) {
        return reply.code(403).send({
          error: 'rls_violation',
          code: '42501',
          message: msg,
          hint: 'this user cannot read admissions rows (check RLS SELECT policy)',
        });
      }
      return reply.code(500).send({ error: 'search_failed', code, message: msg });
    }
  });
}
