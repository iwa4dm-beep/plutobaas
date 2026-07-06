import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { logAudit } from '../audit/logger.js';

// ---------- helpers ----------

const slugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'lowercase slug, 2-63 chars');
const uuidSchema = z.string().uuid();

type Actor = {
  userId: string;
  role: 'authenticated' | 'service_role';
  isSuperadmin: boolean;
};

async function requireAuth(req: FastifyRequest, cfg: Config): Promise<Actor> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  const userId = decoded?.sub;
  if (!userId) { const e: any = new Error('Invalid token'); e.statusCode = 401; throw e; }
  const sql = getSql(cfg);
  const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${userId}`;
  return {
    userId,
    role: decoded?.role === 'service_role' ? 'service_role' : 'authenticated',
    isSuperadmin: !!u?.is_superadmin,
  };
}

async function requireProjectRole(
  cfg: Config, projectId: string, actor: Actor, roles: string[],
): Promise<void> {
  if (actor.isSuperadmin || actor.role === 'service_role') return;
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select role from admin.project_members
    where project_id = ${projectId} and user_id = ${actor.userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: any = new Error('Forbidden'); e.statusCode = 403; throw e;
  }
}

async function requireWorkspaceRole(
  cfg: Config, workspaceId: string, actor: Actor, roles: string[],
): Promise<void> {
  if (actor.isSuperadmin || actor.role === 'service_role') return;
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select role from admin.workspace_members
    where workspace_id = ${workspaceId} and user_id = ${actor.userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: any = new Error('Forbidden'); e.statusCode = 403; throw e;
  }
}

async function defaultWorkspaceForActor(cfg: Config, actor: Actor): Promise<string> {
  const sql = getSql(cfg);
  const rows = actor.isSuperadmin || actor.role === 'service_role'
    ? await sql<any[]>`select id from admin.workspaces where archived_at is null order by created_at asc limit 1`
    : await sql<any[]>`
        select w.id from admin.workspaces w
        join admin.workspace_members m on m.workspace_id = w.id
        where m.user_id = ${actor.userId} and w.archived_at is null
        order by w.created_at asc limit 1`;
  if (rows[0]?.id) return rows[0].id;

  const slug = 'workspace-' + randomBytes(4).toString('hex');
  const [ws] = await sql<any[]>`
    insert into admin.workspaces (slug, name, owner_id)
    values (${slug}, 'Root workspace', ${actor.userId})
    returning id`;
  await sql`
    insert into admin.workspace_members (workspace_id, user_id, role)
    values (${ws.id}, ${actor.userId}, 'owner')
    on conflict do nothing`;
  return ws.id;
}

function mintApiKey(role: 'anon' | 'authenticated' | 'service_role'): {
  key: string; prefix: string; hash: string;
} {
  const prefix = role === 'service_role' ? 'pluto_sk_' : 'pluto_pk_';
  const key = prefix + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  return { key, prefix: key.slice(0, 12), hash };
}

// ---------- schemas ----------

const createProjectBody = z.object({
  name: z.string().min(1).max(120),
  slug: slugSchema,
  workspace_id: uuidSchema.optional(),
});

const addMemberBody = z.object({
  user_id: uuidSchema,
  role: z.enum(['owner', 'admin', 'developer', 'viewer']),
});

const createKeyBody = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(['anon', 'authenticated', 'service_role']).optional(),
  kind: z.enum(['anon', 'authenticated', 'service_role']).optional(),
});

const createWorkspaceBody = z.object({
  slug: slugSchema,
  name: z.string().min(1).max(120),
});

const addWorkspaceMemberBody = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
  user_id: uuidSchema.optional(),
  role: z.enum(['owner', 'admin', 'developer', 'viewer']),
}).refine((v) => !!v.email || !!v.user_id, { message: 'email or user_id is required' });

const patchWorkspaceMemberBody = z.object({
  role: z.enum(['owner', 'admin', 'developer', 'viewer']),
});

// ---------- routes ----------

export async function adminRoutes(app: FastifyInstance, cfg: Config) {
  // Bootstrap superadmin from env on boot (idempotent)
  const rootEmail = process.env.PLUTO_ROOT_EMAIL;
  if (rootEmail) {
    try {
      const sql = getSql(cfg);
      await sql`
        insert into admin.runtime_config (key, value, updated_at)
        values ('root_email', ${rootEmail.toLowerCase()}, now())
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
      `;
      await sql`update auth.users set is_superadmin = true where lower(email) = ${rootEmail.toLowerCase()}`;
    } catch (e: any) {
      app.log.warn({ err: e.message }, 'admin: could not bootstrap superadmin');
    }
  }

  // --- Whoami / health ---
  app.get('/admin/v1/whoami', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    return reply.send(actor);
  });

  // --- Workspaces ---
  app.get('/admin/v1/workspaces', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const rows = actor.isSuperadmin || actor.role === 'service_role'
      ? await sql`
          select w.*,
                 (select count(*)::int from admin.workspace_members m where m.workspace_id = w.id) as member_count,
                 (select count(*)::int from admin.api_keys k join admin.projects p on p.id = k.project_id where p.workspace_id = w.id and k.revoked_at is null) as active_keys
          from admin.workspaces w
          order by w.created_at desc`
      : await sql`
          select w.*,
                 (select count(*)::int from admin.workspace_members m2 where m2.workspace_id = w.id) as member_count,
                 (select count(*)::int from admin.api_keys k join admin.projects p on p.id = k.project_id where p.workspace_id = w.id and k.revoked_at is null) as active_keys
          from admin.workspaces w
          join admin.workspace_members m on m.workspace_id = w.id
          where m.user_id = ${actor.userId}
          order by w.created_at desc`;
    return reply.send({ workspaces: rows });
  });

  app.post('/admin/v1/workspaces', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createWorkspaceBody.parse(req.body);
    const anon = mintApiKey('anon');
    const svc = mintApiKey('service_role');
    const sql = getSql(cfg);
    const result = await sql.begin(async (tx) => {
      const [workspace] = await tx<any[]>`
        insert into admin.workspaces (slug, name, owner_id)
        values (${body.slug}, ${body.name}, ${actor.userId})
        returning id, slug, name, created_at, archived_at`;
      await tx`
        insert into admin.workspace_members (workspace_id, user_id, role)
        values (${workspace.id}, ${actor.userId}, 'owner')
        on conflict do nothing`;
      const [project] = await tx<any[]>`
        insert into admin.projects (name, slug, owner_id, workspace_id)
        values (${body.name}, ${body.slug}, ${actor.userId}, ${workspace.id})
        returning id, slug, name`;
      await tx`
        insert into admin.project_members (project_id, user_id, role)
        values (${project.id}, ${actor.userId}, 'owner')
        on conflict do nothing`;
      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-anon', ${anon.hash}, ${anon.prefix}, 'anon')`;
      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-service-role', ${svc.hash}, ${svc.prefix}, 'service_role')`;
      return { ...workspace, project };
    });
    await logAudit(cfg, { actor_id: actor.userId, project_id: result.project.id, action: 'workspace.create', resource_type: 'workspace', resource_id: result.id, params: { slug: body.slug } });
    return reply.code(201).send({ ...result, keys: { anon: anon.key, service_role: svc.key } });
  });

  app.get<{ Params: { id: string } }>('/admin/v1/workspaces/:id/members', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer', 'viewer']);
    const rows = await getSql(cfg)`
      select m.user_id, m.role, m.created_at, u.email
      from admin.workspace_members m
      join auth.users u on u.id = m.user_id
      where m.workspace_id = ${req.params.id}
      order by m.created_at asc`;
    return reply.send({ members: rows });
  });

  app.post<{ Params: { id: string } }>('/admin/v1/workspaces/:id/members', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const body = addWorkspaceMemberBody.parse(req.body);
    const sql = getSql(cfg);
    let userId = body.user_id;
    if (!userId && body.email) {
      const [u] = await sql<any[]>`
        insert into auth.users (email, email_confirmed_at)
        values (${body.email}, now())
        on conflict (email) do update set updated_at = now()
        returning id`;
      userId = u.id;
    }
    const [row] = await sql<any[]>`
      insert into admin.workspace_members (workspace_id, user_id, role)
      values (${req.params.id}, ${userId}, ${body.role})
      on conflict (workspace_id, user_id) do update set role = excluded.role
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'workspace.member.upsert', resource_type: 'workspace', resource_id: req.params.id, params: { user_id: userId, role: body.role } });
    return reply.code(201).send(row);
  });

  app.patch<{ Params: { id: string; userId: string } }>('/admin/v1/workspaces/:id/members/:userId', async (req, reply) => {
    uuidSchema.parse(req.params.id); uuidSchema.parse(req.params.userId);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const body = patchWorkspaceMemberBody.parse(req.body);
    const [row] = await getSql(cfg)<any[]>`
      update admin.workspace_members set role = ${body.role}
      where workspace_id = ${req.params.id} and user_id = ${req.params.userId}
      returning *`;
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply.send(row);
  });

  app.delete<{ Params: { id: string; userId: string } }>('/admin/v1/workspaces/:id/members/:userId', async (req, reply) => {
    uuidSchema.parse(req.params.id); uuidSchema.parse(req.params.userId);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin']);
    await getSql(cfg)`delete from admin.workspace_members where workspace_id = ${req.params.id} and user_id = ${req.params.userId}`;
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/admin/v1/workspaces/:id/keys', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer', 'viewer']);
    const rows = await getSql(cfg)<any[]>`
      select k.id, k.name, k.key_prefix, k.role as kind, k.created_at, k.revoked_at,
             null::timestamptz as last_used_at, 0::bigint as use_count
      from admin.api_keys k
      join admin.projects p on p.id = k.project_id
      where p.workspace_id = ${req.params.id}
      order by k.created_at desc`;
    return reply.send({ keys: rows, items: rows });
  });

  app.post<{ Params: { id: string } }>('/admin/v1/workspaces/:id/keys', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const parsed = createKeyBody.parse(req.body);
    const role = parsed.role ?? parsed.kind ?? 'anon';
    const sql = getSql(cfg);
    const [project] = await sql<any[]>`
      select id from admin.projects where workspace_id = ${req.params.id} order by created_at asc limit 1`;
    if (!project) return reply.code(404).send({ error: 'workspace_has_no_project' });
    const minted = mintApiKey(role);
    const [row] = await sql<any[]>`
      insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
      values (${project.id}, ${parsed.name}, ${minted.hash}, ${minted.prefix}, ${role})
      returning id, name, key_prefix, role as kind, created_at, revoked_at`;
    await logAudit(cfg, { actor_id: actor.userId, project_id: project.id, action: 'workspace_key.create', resource_type: 'api_key', resource_id: row.id, params: { workspace_id: req.params.id, role } });
    return reply.code(201).send({ ...row, plaintext: minted.key, api_key: minted.key, last_used_at: null, use_count: 0 });
  });

  async function revokeWorkspaceKey(req: FastifyRequest, reply: any) {
    const params = req.params as { id: string; keyId: string };
    uuidSchema.parse(params.id); uuidSchema.parse(params.keyId);
    const actor = await requireAuth(req, cfg);
    await requireWorkspaceRole(cfg, params.id, actor, ['owner', 'admin']);
    await getSql(cfg)`
      update admin.api_keys k set revoked_at = now()
      from admin.projects p
      where k.id = ${params.keyId} and p.id = k.project_id and p.workspace_id = ${params.id}`;
    return reply.send({ ok: true });
  }

  app.post('/admin/v1/workspaces/:id/keys/:keyId/revoke', revokeWorkspaceKey);
  app.delete('/admin/v1/workspaces/:id/keys/:keyId', revokeWorkspaceKey);

  // --- Projects ---
  app.get('/admin/v1/projects', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const rows = actor.isSuperadmin
      ? await sql`select * from admin.projects order by created_at desc`
      : await sql`
          select p.* from admin.projects p
          join admin.project_members m on m.project_id = p.id
          where m.user_id = ${actor.userId}
          order by p.created_at desc`;
    return reply.send(rows);
  });

  app.post('/admin/v1/projects', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = createProjectBody.parse(req.body);
    const sql = getSql(cfg);
    const workspaceId = body.workspace_id ?? await defaultWorkspaceForActor(cfg, actor);
    await requireWorkspaceRole(cfg, workspaceId, actor, ['owner', 'admin', 'developer']);
    const result = await sql.begin(async (tx) => {
      const [p] = await tx<any[]>`
        insert into admin.projects (name, slug, owner_id, workspace_id)
        values (${body.name}, ${body.slug}, ${actor.userId}, ${workspaceId})
        returning *`;
      await tx`
        insert into admin.project_members (project_id, user_id, role)
        values (${p.id}, ${actor.userId}, 'owner')`;
      await tx`
        insert into admin.workspace_members (workspace_id, user_id, role)
        values (${workspaceId}, ${actor.userId}, 'owner')
        on conflict do nothing`;
      return p;
    });
    await logAudit(cfg, { actor_id: actor.userId, project_id: result.id, action: 'project.create', resource_type: 'project', resource_id: result.id, params: { workspace_id: workspaceId, slug: body.slug } });
    return reply.code(201).send(result);
  });

  app.get<{ Params: { id: string } }>('/admin/v1/projects/:id', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer', 'viewer']);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`select * from admin.projects where id = ${req.params.id}`;
    if (!row) return reply.code(404).send({ error: 'Not found' });
    return reply.send(row);
  });

  app.delete<{ Params: { id: string } }>('/admin/v1/projects/:id', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner']);
    const sql = getSql(cfg);
    await sql`delete from admin.projects where id = ${req.params.id}`;
    return reply.send({ message: 'Deleted' });
  });

  // --- Project members ---
  app.get<{ Params: { id: string } }>('/admin/v1/projects/:id/members', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer', 'viewer']);
    const sql = getSql(cfg);
    const rows = await sql`
      select m.user_id, m.role, m.created_at, u.email
      from admin.project_members m
      join auth.users u on u.id = m.user_id
      where m.project_id = ${req.params.id}
      order by m.created_at asc`;
    return reply.send(rows);
  });

  app.post<{ Params: { id: string } }>('/admin/v1/projects/:id/members', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const body = addMemberBody.parse(req.body);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into admin.project_members (project_id, user_id, role)
      values (${req.params.id}, ${body.user_id}, ${body.role})
      on conflict (project_id, user_id) do update set role = excluded.role
      returning *`;
    return reply.code(201).send(row);
  });

  app.delete<{ Params: { id: string; userId: string } }>(
    '/admin/v1/projects/:id/members/:userId',
    async (req, reply) => {
      uuidSchema.parse(req.params.id);
      uuidSchema.parse(req.params.userId);
      const actor = await requireAuth(req, cfg);
      await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
      const sql = getSql(cfg);
      await sql`
        delete from admin.project_members
        where project_id = ${req.params.id} and user_id = ${req.params.userId}`;
      return reply.send({ message: 'Removed' });
    },
  );

  // --- Project API keys ---
  app.get<{ Params: { id: string } }>('/admin/v1/projects/:id/keys', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer']);
    const sql = getSql(cfg);
    const rows = await sql`
      select id, name, key_prefix, role, role as kind, created_at, revoked_at,
             null::timestamptz as last_used_at, 0::bigint as use_count
      from admin.api_keys
      where project_id = ${req.params.id}
      order by created_at desc`;
    return reply.send(rows);
  });

  app.post<{ Params: { id: string } }>('/admin/v1/projects/:id/keys', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
    const body = createKeyBody.parse(req.body);
    const role = body.role ?? body.kind ?? 'anon';
    const minted = mintApiKey(role);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
      values (${req.params.id}, ${body.name}, ${minted.hash}, ${minted.prefix}, ${role})
      returning id, name, key_prefix, role, role as kind, created_at`;
    return reply.code(201).send({ ...row, api_key: minted.key, plaintext: minted.key });
  });

  app.delete<{ Params: { id: string; keyId: string } }>(
    '/admin/v1/projects/:id/keys/:keyId',
    async (req, reply) => {
      uuidSchema.parse(req.params.id);
      uuidSchema.parse(req.params.keyId);
      const actor = await requireAuth(req, cfg);
      await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
      const sql = getSql(cfg);
      await sql`
        update admin.api_keys set revoked_at = now()
        where id = ${req.params.keyId} and project_id = ${req.params.id}`;
      return reply.send({ message: 'Revoked' });
    },
  );

  app.post<{ Params: { id: string; keyId: string } }>(
    '/admin/v1/projects/:id/keys/:keyId/rotate',
    async (req, reply) => {
      uuidSchema.parse(req.params.id);
      uuidSchema.parse(req.params.keyId);
      const actor = await requireAuth(req, cfg);
      await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin']);
      const sql = getSql(cfg);
      const [existing] = await sql<any[]>`
        select name, role from admin.api_keys
        where id = ${req.params.keyId} and project_id = ${req.params.id}`;
      if (!existing) return reply.code(404).send({ error: 'not found' });
      await sql`update admin.api_keys set revoked_at = now()
        where id = ${req.params.keyId} and project_id = ${req.params.id} and revoked_at is null`;
      const minted = mintApiKey(existing.role);
      const rotatedName = `${existing.name}-rot-${Date.now().toString(36)}`;
      const [row] = await sql<any[]>`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${req.params.id}, ${rotatedName}, ${minted.hash}, ${minted.prefix}, ${existing.role})
        returning id, name, key_prefix, role, role as kind, created_at`;
      return reply.code(201).send({ ...row, api_key: minted.key, plaintext: minted.key, rotated_from: req.params.keyId });
    },
  );

  // --- Superadmin: users / stats ---
  app.get('/admin/v1/users', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    if (!actor.isSuperadmin && actor.role !== 'service_role') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const sql = getSql(cfg);
    const rows = await sql`
      select id, email, role, is_superadmin, last_sign_in_at, created_at
      from auth.users order by created_at desc limit 500`;
    return reply.send(rows);
  });

  app.get('/admin/v1/stats', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    if (!actor.isSuperadmin && actor.role !== 'service_role') {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const [row] = await getSql(cfg)<any[]>`select * from admin.v_stats`;
    return reply.send(row ?? { users: 0, workspaces: 0, projects: 0, buckets: 0, storage_bytes: 0, objects: 0, ts: new Date().toISOString() });
  });

  const patchUserBody = z.object({
    role: z.enum(['user', 'admin', 'super_admin']).optional(),
    is_superadmin: z.boolean().optional(),
    email_verified: z.boolean().optional(),
  }).refine((v) => v.role !== undefined || v.is_superadmin !== undefined || v.email_verified !== undefined, {
    message: 'At least one of role, is_superadmin, email_verified is required',
  });

  app.patch<{ Params: { id: string } }>(
    '/admin/v1/users/:id',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      if (!actor.isSuperadmin && actor.role !== 'service_role') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const idParse = uuidSchema.safeParse(req.params.id);
      if (!idParse.success) return reply.code(400).send({ error: 'invalid_uuid' });
      const bodyParse = patchUserBody.safeParse(req.body ?? {});
      if (!bodyParse.success) return reply.code(400).send({ error: 'invalid_body', issues: bodyParse.error.issues });

      let dbRole: 'user' | 'admin' | undefined;
      let dbSuper: boolean | undefined;
      if (bodyParse.data.role === 'super_admin') { dbRole = 'admin'; dbSuper = true; }
      else if (bodyParse.data.role === 'admin')  { dbRole = 'admin'; dbSuper = false; }
      else if (bodyParse.data.role === 'user')   { dbRole = 'user';  dbSuper = false; }
      if (bodyParse.data.is_superadmin !== undefined) dbSuper = bodyParse.data.is_superadmin;

      const sql = getSql(cfg);
      const [row] = await sql<any[]>`
        update auth.users set
          role           = coalesce(${dbRole ?? null}::text,   role),
          is_superadmin  = coalesce(${dbSuper ?? null}::boolean, is_superadmin),
          email_verified = coalesce(${bodyParse.data.email_verified ?? null}::boolean, email_verified)
        where id = ${req.params.id}
        returning id, email, role, is_superadmin, email_verified, last_sign_in_at, created_at`;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return reply.send(row);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/admin/v1/users/:id',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      if (!actor.isSuperadmin && actor.role !== 'service_role') {
        return reply.code(403).send({ error: 'Forbidden' });
      }
      const idParse = uuidSchema.safeParse(req.params.id);
      if (!idParse.success) return reply.code(400).send({ error: 'invalid_uuid' });
      if (req.params.id === actor.userId) {
        return reply.code(400).send({ error: 'cannot_delete_self' });
      }
      const sql = getSql(cfg);
      const [row] = await sql<any[]>`
        delete from auth.users where id = ${req.params.id}
        returning id`;
      if (!row) return reply.code(404).send({ error: 'not_found' });
      return reply.code(204).send();
    },
  );

  // --- Public: config for the frontend dashboard ---
  app.get('/admin/v1/settings', async () => ({
    service: 'pluto-admin',
    version: '0.1.0',
    features: {
      auth: true, rest: true, storage: true, realtime: true,
      multi_tenant: true,
    },
  }));
}