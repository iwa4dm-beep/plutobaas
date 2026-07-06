// Workspace API tokens: scoped bearer tokens for CI, scripts, and external
// integrations. Tokens are shown once; only a SHA-256 hash is stored.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, type Actor } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const SCOPES = [
  'usage:read',
  'logs:read',
  'logs:write',
  'db:read',
  'db:write',
  'storage:read',
  'storage:write',
  'functions:invoke',
  'realtime:read',
  'realtime:write',
  'admin:read',
  'admin:write',
  '*',
] as const;

const COVERAGE: Record<string, Array<{ method: string; path: string; description: string }>> = {
  'usage:read': [
    { method: 'GET', path: '/tokens/v1/whoami', description: 'Verify a token and inspect scopes' },
    { method: 'GET', path: '/health/*', description: 'Read health and migration status' },
  ],
  'logs:read': [{ method: 'GET', path: '/logs/v1/*', description: 'Read audit and log exports' }],
  'logs:write': [{ method: 'POST', path: '/logs/v1/export', description: 'Create log export jobs' }],
  'db:read': [{ method: 'GET', path: '/rest/v1/*', description: 'Read database rows' }],
  'db:write': [{ method: 'POST/PATCH/DELETE', path: '/rest/v1/*', description: 'Write database rows' }],
  'storage:read': [{ method: 'GET', path: '/storage/v1/*', description: 'Read buckets and objects' }],
  'storage:write': [{ method: 'POST/PUT/DELETE', path: '/storage/v1/*', description: 'Write buckets and objects' }],
  'functions:invoke': [{ method: 'POST', path: '/functions/v1/*', description: 'Invoke edge functions' }],
  'realtime:read': [{ method: 'GET', path: '/realtime/v1/*', description: 'Subscribe to realtime channels' }],
  'realtime:write': [{ method: 'POST', path: '/realtime/v1/broadcast', description: 'Broadcast realtime events' }],
  'admin:read': [{ method: 'GET', path: '/admin/v1/*', description: 'Read admin resources' }],
  'admin:write': [{ method: 'POST/PATCH/DELETE', path: '/admin/v1/*', description: 'Mutate admin resources' }],
  '*': [{ method: '*', path: '*', description: 'All scopes' }],
};

const createBody = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z.array(z.string().min(1).max(80)).min(1).max(64),
  expires_in_days: z.number().int().min(1).max(365).optional(),
  workspace_id: z.string().uuid().optional(),
});

const rotateBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  expires_in_days: z.number().int().min(1).max(365).optional(),
}).optional().default({});

const bulkBody = z.object({
  scope: z.string().optional(),
  created_by: z.string().uuid().optional(),
  last_used_before: z.string().datetime().optional(),
  never_used: z.boolean().optional(),
  include_expired: z.boolean().optional(),
  ids: z.array(z.string().uuid()).optional(),
  dry_run: z.boolean().optional().default(true),
});

function hash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function mintToken(): { raw: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString('hex');
  const raw = 'plt_' + prefix + '_' + randomBytes(32).toString('base64url');
  return { raw, prefix, hash: hash(raw) };
}

function validateScopes(scopes: string[]) {
  if (scopes.includes('*')) return ['*'];
  const allowed = new Set<string>(SCOPES);
  const bad = scopes.filter((s) => !allowed.has(s));
  if (bad.length) {
    const e: Error & { statusCode?: number } = new Error(`Unknown scope(s): ${bad.join(', ')}`);
    e.statusCode = 400;
    throw e;
  }
  return [...new Set(scopes)].sort();
}

async function requireWorkspaceRole(cfg: Config, workspaceId: string, actor: Actor, roles: string[]) {
  if (actor.isSuperadmin || actor.role === 'service_role') return;
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select role from admin.workspace_members
    where workspace_id = ${workspaceId} and user_id = ${actor.userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: Error & { statusCode?: number } = new Error('Forbidden');
    e.statusCode = 403;
    throw e;
  }
}

async function resolveWorkspaceId(cfg: Config, actor: Actor, requested?: string): Promise<string> {
  const sql = getSql(cfg);
  if (requested) {
    await requireWorkspaceRole(cfg, requested, actor, ['owner', 'admin', 'developer', 'viewer']);
    return requested;
  }
  const rows = actor.isSuperadmin || actor.role === 'service_role'
    ? await sql<any[]>`select id from admin.workspaces where archived_at is null order by created_at asc limit 1`
    : await sql<any[]>`
        select w.id from admin.workspaces w
        join admin.workspace_members m on m.workspace_id = w.id
        where m.user_id = ${actor.userId} and w.archived_at is null
        order by w.created_at asc limit 1`;
  if (rows[0]?.id) return rows[0].id;

  const [ws] = await sql<any[]>`
    insert into admin.workspaces (slug, name, owner_id)
    values (${'root-' + randomBytes(3).toString('hex')}, 'Root workspace', ${actor.userId})
    returning id`;
  await sql`
    insert into admin.workspace_members (workspace_id, user_id, role)
    values (${ws.id}, ${actor.userId}, 'owner')
    on conflict do nothing`;
  return ws.id;
}

async function verifyWorkspaceToken(req: FastifyRequest, cfg: Config) {
  const h = req.headers.authorization;
  const raw = h?.startsWith('Bearer ') ? h.slice('Bearer '.length) : '';
  if (!raw.startsWith('plt_')) {
    const e: Error & { statusCode?: number } = new Error('Missing or malformed workspace token');
    e.statusCode = 401;
    throw e;
  }
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select id, workspace_id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
    from admin.workspace_tokens
    where token_hash = ${hash(raw)}
    limit 1`;
  if (!row) { const e: Error & { statusCode?: number } = new Error('Invalid token'); e.statusCode = 401; throw e; }
  if (row.revoked_at) { const e: Error & { statusCode?: number } = new Error('Token revoked'); e.statusCode = 401; throw e; }
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    const e: Error & { statusCode?: number } = new Error('Token expired'); e.statusCode = 401; throw e;
  }
  await sql`update admin.workspace_tokens set last_used_at = now() where id = ${row.id}`;
  return row;
}

export async function tokensRoutes(app: FastifyInstance, cfg: Config) {
  // /tokens/v1/health is registered by health.ts (shared health route registry)
  app.get('/tokens/v1/scopes', async () => ({ scopes: SCOPES }));
  app.get('/tokens/v1/coverage', async () => ({ coverage: COVERAGE }));

  app.get('/tokens/v1/tokens', async (req) => {
    const actor = await requireAuth(req, cfg);
    const workspaceId = await resolveWorkspaceId(cfg, actor);
    await requireWorkspaceRole(cfg, workspaceId, actor, ['owner', 'admin', 'developer', 'viewer']);
    const rows = await getSql(cfg)<any[]>`
      select id, workspace_id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at
      from admin.workspace_tokens
      where workspace_id = ${workspaceId}
      order by revoked_at nulls first, created_at desc
      limit 500`;
    return { tokens: rows };
  });

  app.post('/tokens/v1/tokens', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createBody.parse(req.body);
    const workspaceId = await resolveWorkspaceId(cfg, actor, body.workspace_id);
    await requireWorkspaceRole(cfg, workspaceId, actor, ['owner', 'admin']);
    const scopes = validateScopes(body.scopes);
    const secret = mintToken();
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 24 * 3600 * 1000).toISOString()
      : null;
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.workspace_tokens (workspace_id, name, token_hash, prefix, scopes, created_by, expires_at)
      values (${workspaceId}, ${body.name}, ${secret.hash}, ${secret.prefix}, ${scopes as unknown as string[]}, ${actor.userId}, ${expiresAt})
      returning id, workspace_id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'workspace_token.create', resource_type: 'workspace_token', resource_id: row.id, params: { workspace_id: workspaceId, scopes, prefix: secret.prefix } });
    return reply.code(201).send({ ...row, token: secret.raw });
  });

  app.delete<{ Params: { id: string } }>('/tokens/v1/tokens/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [existing] = await sql<any[]>`select workspace_id from admin.workspace_tokens where id = ${req.params.id}`;
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    await requireWorkspaceRole(cfg, existing.workspace_id, actor, ['owner', 'admin']);
    await sql`update admin.workspace_tokens set revoked_at = coalesce(revoked_at, now()) where id = ${req.params.id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'workspace_token.revoke', resource_type: 'workspace_token', resource_id: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/tokens/v1/tokens/:id/rotate', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = rotateBody.parse(req.body ?? {});
    const sql = getSql(cfg);
    const [old] = await sql<any[]>`select * from admin.workspace_tokens where id = ${req.params.id}`;
    if (!old) return reply.code(404).send({ error: 'not_found' });
    await requireWorkspaceRole(cfg, old.workspace_id, actor, ['owner', 'admin']);
    const secret = mintToken();
    const expiresAt = body.expires_in_days !== undefined
      ? new Date(Date.now() + body.expires_in_days * 24 * 3600 * 1000).toISOString()
      : old.expires_at;
    await sql`update admin.workspace_tokens set revoked_at = coalesce(revoked_at, now()) where id = ${req.params.id}`;
    const [row] = await sql<any[]>`
      insert into admin.workspace_tokens (workspace_id, name, token_hash, prefix, scopes, created_by, expires_at)
      values (${old.workspace_id}, ${body.name ?? old.name}, ${secret.hash}, ${secret.prefix}, ${old.scopes as unknown as string[]}, ${actor.userId}, ${expiresAt})
      returning id, workspace_id, name, prefix, scopes, created_at, last_used_at, expires_at, revoked_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'workspace_token.rotate', resource_type: 'workspace_token', resource_id: row.id, params: { replaced_id: req.params.id } });
    return reply.code(201).send({ ...row, token: secret.raw, replaced_id: req.params.id });
  });

  app.post('/tokens/v1/tokens/bulk-revoke', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = bulkBody.parse(req.body ?? {});
    const workspaceId = await resolveWorkspaceId(cfg, actor);
    await requireWorkspaceRole(cfg, workspaceId, actor, ['owner', 'admin']);
    const rows = await getSql(cfg)<any[]>`
      select id, name, prefix, scopes, created_by, last_used_at, expires_at
      from admin.workspace_tokens
      where workspace_id = ${workspaceId}
        and revoked_at is null
        and (${body.scope ?? null}::text is null or ${body.scope ?? null} = any(scopes))
        and (${body.created_by ?? null}::uuid is null or created_by = ${body.created_by ?? null}::uuid)
        and (${body.last_used_before ?? null}::timestamptz is null or last_used_at < ${body.last_used_before ?? null}::timestamptz)
        and (${body.never_used ?? false}::boolean is false or last_used_at is null)
        and (${body.include_expired ?? false}::boolean is true or expires_at is null or expires_at > now())
        and (${body.ids ?? null}::uuid[] is null or id = any(${body.ids ?? null}::uuid[]))
      order by created_at desc
      limit 500`;
    if (!body.dry_run && rows.length) {
      await getSql(cfg)`update admin.workspace_tokens set revoked_at = now() where id = any(${rows.map((r) => r.id)}::uuid[])`;
      await logAudit(cfg, { actor_id: actor.userId, action: 'workspace_token.bulk_revoke', params: { matched: rows.length } });
    }
    return {
      dry_run: body.dry_run,
      matched: rows.length,
      revoked: body.dry_run ? [] : rows.map((r) => r.id),
      tokens: rows,
    };
  });

  app.get('/tokens/v1/whoami', async (req) => {
    const row = await verifyWorkspaceToken(req, cfg);
    return { workspace_id: row.workspace_id, scopes: row.scopes, token_id: row.id, name: row.name };
  });
}