import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

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
});

const addMemberBody = z.object({
  user_id: uuidSchema,
  role: z.enum(['owner', 'admin', 'developer', 'viewer']),
});

const createKeyBody = z.object({
  name: z.string().min(1).max(80),
  role: z.enum(['anon', 'authenticated', 'service_role']),
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
    const result = await sql.begin(async (tx) => {
      const [p] = await tx<any[]>`
        insert into admin.projects (name, slug, owner_id)
        values (${body.name}, ${body.slug}, ${actor.userId})
        returning *`;
      await tx`
        insert into admin.project_members (project_id, user_id, role)
        values (${p.id}, ${actor.userId}, 'owner')`;
      return p;
    });
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

  // --- Members ---
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

  // --- API keys ---
  app.get<{ Params: { id: string } }>('/admin/v1/projects/:id/keys', async (req, reply) => {
    uuidSchema.parse(req.params.id);
    const actor = await requireAuth(req, cfg);
    await requireProjectRole(cfg, req.params.id, actor, ['owner', 'admin', 'developer']);
    const sql = getSql(cfg);
    const rows = await sql`
      select id, name, key_prefix, role, created_at, revoked_at
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
    const minted = mintApiKey(body.role);
    const sql = getSql(cfg);
    const [row] = await sql<any[]>`
      insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
      values (${req.params.id}, ${body.name}, ${minted.hash}, ${minted.prefix}, ${body.role})
      returning id, name, key_prefix, role, created_at`;
    // Key value returned ONCE — never stored plain, cannot be retrieved again.
    return reply.code(201).send({ ...row, api_key: minted.key });
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

  // Rotate: revoke old + mint replacement with same name/role. Plaintext returned once.
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
        returning id, name, key_prefix, role, created_at`;
      return reply.code(201).send({ ...row, api_key: minted.key, rotated_from: req.params.keyId });
    },
  );


  // --- Superadmin: users list ---
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

  // --- Superadmin: update user (role + is_superadmin + email_verified) ---
  // Role model: three logical roles surfaced to the dashboard:
  //   'user'        -> role='user',  is_superadmin=false
  //   'admin'       -> role='admin', is_superadmin=false
  //   'super_admin' -> role='admin', is_superadmin=true
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

  // --- Superadmin: delete user ---
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

  // audit log endpoint is registered in auditRoutes (routes/audit.ts)



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
