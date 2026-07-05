import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

const orgBody = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: z.string().min(1).max(120),
  billing_email: z.string().email().optional(),
});

const memberBody = z.object({
  org_id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['owner', 'admin', 'developer', 'viewer']).default('developer'),
});

const inviteBody = z.object({
  org_id: z.string().uuid(),
  email: z.string().email(),
  role: z.enum(['owner', 'admin', 'developer', 'viewer']).default('developer'),
});

const keyBody = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1).max(60),
  scopes: z.array(z.enum(['read', 'write', 'admin'])).min(1).default(['read']),
  expires_at: z.string().datetime().optional(),
});

async function requireOrgRole(cfg: Config, orgId: string, userId: string, roles: string[]) {
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`select role from admin.organization_members where org_id = ${orgId} and user_id = ${userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: any = new Error('Forbidden'); e.statusCode = 403; throw e;
  }
}

export async function orgsRoutes(app: FastifyInstance, cfg: Config) {
  // ---------- Organizations ----------
  app.get('/admin/v1/orgs', async (req) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    return sql`
      select o.*, m.role as my_role
      from admin.organizations o
      join admin.organization_members m on m.org_id = o.id
      where m.user_id = ${actor.userId}
      order by o.created_at desc`;
  });

  app.post('/admin/v1/orgs', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = orgBody.parse(req.body);
    const sql = getSql(cfg);
    const [org] = await sql<any[]>`
      insert into admin.organizations (slug, name, billing_email, created_by)
      values (${body.slug}, ${body.name}, ${body.billing_email ?? null}, ${actor.userId})
      returning *`;
    await sql`insert into admin.organization_members (org_id, user_id, role) values (${org.id}, ${actor.userId}, 'owner')`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.create', target: org.id, detail: body });
    reply.code(201).send(org);
  });

  app.delete('/admin/v1/orgs/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await requireOrgRole(cfg, id, actor.userId, ['owner']);
    await getSql(cfg)`delete from admin.organizations where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.delete', target: id });
    reply.code(204).send();
  });

  // ---------- Members ----------
  app.get('/admin/v1/orgs/:id/members', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await requireOrgRole(cfg, id, actor.userId, ['owner', 'admin', 'developer', 'viewer']);
    return getSql(cfg)`
      select m.*, u.email
      from admin.organization_members m
      left join auth.users u on u.id = m.user_id
      where m.org_id = ${id} order by m.added_at`;
  });

  app.post('/admin/v1/orgs/members', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = memberBody.parse(req.body);
    await requireOrgRole(cfg, body.org_id, actor.userId, ['owner', 'admin']);
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.organization_members (org_id, user_id, role)
      values (${body.org_id}, ${body.user_id}, ${body.role})
      on conflict (org_id, user_id) do update set role = excluded.role
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.member.upsert', target: body.org_id, detail: body });
    reply.code(201).send(row);
  });

  app.delete('/admin/v1/orgs/:org/members/:user', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { org, user } = req.params as any;
    await requireOrgRole(cfg, org, actor.userId, ['owner', 'admin']);
    await getSql(cfg)`delete from admin.organization_members where org_id = ${org} and user_id = ${user}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.member.remove', target: `${org}:${user}` });
    reply.code(204).send();
  });

  // ---------- Invites ----------
  app.get('/admin/v1/orgs/:id/invites', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await requireOrgRole(cfg, id, actor.userId, ['owner', 'admin']);
    return getSql(cfg)`select id, email, role, expires_at, accepted_at, created_at from admin.organization_invites where org_id = ${id} order by created_at desc`;
  });

  app.post('/admin/v1/orgs/invites', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = inviteBody.parse(req.body);
    await requireOrgRole(cfg, body.org_id, actor.userId, ['owner', 'admin']);
    const token = randomBytes(24).toString('base64url');
    const [inv] = await getSql(cfg)<any[]>`
      insert into admin.organization_invites (org_id, email, role, token, invited_by)
      values (${body.org_id}, ${body.email}, ${body.role}, ${token}, ${actor.userId})
      returning id, org_id, email, role, expires_at, token`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.invite.create', target: body.org_id, detail: { email: body.email, role: body.role } });
    reply.code(201).send(inv);
  });

  app.post('/admin/v1/orgs/invites/accept', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const sql = getSql(cfg);
    const [inv] = await sql<any[]>`
      select * from admin.organization_invites
      where token = ${token} and accepted_at is null and expires_at > now()`;
    if (!inv) { reply.code(400).send({ error: 'invalid_or_expired' }); return; }
    await sql`insert into admin.organization_members (org_id, user_id, role) values (${inv.org_id}, ${actor.userId}, ${inv.role}) on conflict do nothing`;
    await sql`update admin.organization_invites set accepted_at = now() where id = ${inv.id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'org.invite.accept', target: inv.org_id });
    return { org_id: inv.org_id, role: inv.role };
  });

  app.delete('/admin/v1/orgs/invites/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const sql = getSql(cfg);
    const [inv] = await sql<any[]>`select org_id from admin.organization_invites where id = ${id}`;
    if (!inv) { reply.code(404).send({ error: 'not_found' }); return; }
    await requireOrgRole(cfg, inv.org_id, actor.userId, ['owner', 'admin']);
    await sql`delete from admin.organization_invites where id = ${id}`;
    reply.code(204).send();
  });

  // ---------- Project API keys ----------
  app.get('/admin/v1/projects/:project/api-keys', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { project } = req.params as any;
    void actor;
    return getSql(cfg)`
      select id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
      from admin.project_api_keys where project_id = ${project} order by created_at desc`;
  });

  app.post('/admin/v1/projects/api-keys', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = keyBody.parse(req.body);
    const raw = 'plk_' + randomBytes(24).toString('base64url');
    const hash = createHash('sha256').update(raw).digest('hex');
    const [row] = await getSql(cfg)<any[]>`
      insert into admin.project_api_keys (project_id, name, key_hash, key_prefix, scopes, created_by, expires_at)
      values (${body.project_id}, ${body.name}, ${hash}, ${raw.slice(0, 12)}, ${body.scopes as any}, ${actor.userId}, ${body.expires_at ?? null})
      returning id, name, key_prefix, scopes, expires_at, created_at`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'api_key.create', target: body.project_id, detail: { name: body.name, scopes: body.scopes } });
    reply.code(201).send({ ...row, secret: raw, note: 'Store this — it will not be shown again' });
  });

  app.delete('/admin/v1/projects/api-keys/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await getSql(cfg)`update admin.project_api_keys set revoked_at = now() where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'api_key.revoke', target: id });
    reply.code(204).send();
  });
}
