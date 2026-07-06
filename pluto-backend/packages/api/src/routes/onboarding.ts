// Phase 16 · Onboarding — self-serve signup + per-workspace CORS management.
//
// Endpoints:
//   POST /auth/v1/signup-full
//     Public, rate-limited. Creates user + workspace + project + api keys,
//     optionally seeds a demo schema and adds a workspace-scoped CORS origin,
//     and enqueues a welcome email. Returns keys ONCE.
//
//   POST /admin/v1/projects/:id/domains
//     Workspace owner/admin adds a new website domain that can call the API
//     from the browser. Inserts into admin.cors_origins scoped to the project's
//     workspace and invalidates the origin cache.
//
//   GET  /admin/v1/projects/:id/domains          list origins for the workspace
//   DELETE /admin/v1/projects/:id/domains/:oid   remove one

import type { FastifyInstance, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { invalidateCorsCache } from '../cors/registry.js';

const emailSchema = z.string().trim().toLowerCase().email().max(255);
const originSchema = z
  .string()
  .min(4)
  .max(255)
  .regex(
    /^https?:\/\/[a-z0-9.\-]+(:\d+)?$/i,
    'must be a bare origin like https://app.example.com',
  );

const signupFullBody = z.object({
  email: emailSchema,
  password: z.string().min(8).max(72),
  workspace_name: z.string().trim().min(2).max(80),
  initial_domain: originSchema.optional(),
  seed_demo: z.boolean().optional().default(true),
});

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
  const suffix = randomBytes(3).toString('hex');
  return `${base}-${suffix}`;
}

function mintApiKey(role: 'anon' | 'service_role'): {
  key: string; prefix: string; hash: string;
} {
  const prefix = role === 'service_role' ? 'pluto_sk_' : 'pluto_pk_';
  const key = prefix + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  return { key, prefix: key.slice(0, 12), hash };
}

async function requireAuth(req: FastifyRequest, cfg: Config): Promise<{
  userId: string; isSuperadmin: boolean;
}> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  const userId = decoded?.sub;
  if (!userId) { const e: any = new Error('Invalid token'); e.statusCode = 401; throw e; }
  const sql = getSql(cfg);
  const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${userId}`;
  return { userId, isSuperadmin: !!u?.is_superadmin };
}

async function requireWorkspaceRole(
  cfg: Config, workspaceId: string, userId: string, isSuperadmin: boolean,
  roles: string[],
): Promise<void> {
  if (isSuperadmin) return;
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select role from admin.workspace_members
    where workspace_id = ${workspaceId} and user_id = ${userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: any = new Error('Forbidden'); e.statusCode = 403; throw e;
  }
}

function welcomeEmailHtml(opts: {
  workspace: string;
  anonKey: string;
  apiUrl: string;
  loginUrl: string;
}): string {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
    <h1 style="font-size:24px;margin:0 0 8px">Welcome to Pluto — ${opts.workspace}</h1>
    <p style="color:#475569">Your backend is live. Here is what you need to start building.</p>

    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0">
      <div style="font-size:12px;color:#64748b;margin-bottom:4px">API URL</div>
      <code style="font-size:13px">${opts.apiUrl}</code>
      <div style="font-size:12px;color:#64748b;margin:12px 0 4px">Publishable key (safe for browser)</div>
      <code style="font-size:13px;word-break:break-all">${opts.anonKey}</code>
    </div>

    <p style="color:#475569">
      Your <b>service_role</b> key is in the dashboard — keep it server-side only.
    </p>
    <p><a href="${opts.loginUrl}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open dashboard</a></p>

    <pre style="background:#0f172a;color:#e2e8f0;padding:12px;border-radius:6px;font-size:12px;overflow:auto">curl ${opts.apiUrl}/rest/v1/customers \\
  -H "apikey: ${opts.anonKey}"</pre>

    <p style="color:#94a3b8;font-size:12px;margin-top:24px">You are receiving this because you signed up. Reply to this email if anything looks off.</p>
  </div>`;
}

export async function onboardingRoutes(app: FastifyInstance, cfg: Config) {
  // --- POST /auth/v1/signup-full ---
  app.post('/auth/v1/signup-full', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = signupFullBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    }
    const { email, password, workspace_name, initial_domain, seed_demo } = parsed.data;
    const sql = getSql(cfg);

    // Duplicate check
    const existing = await sql`select id from auth.users where lower(email) = ${email}`;
    if (existing.length) {
      return reply.code(409).send({ error: 'user_already_exists' });
    }

    const encrypted_password = await argon2.hash(password, { type: argon2.argon2id });
    const wsSlug = slugify(workspace_name);
    const projectSlug = slugify(workspace_name);
    const anon = mintApiKey('anon');
    const svc = mintApiKey('service_role');

    // Transactional signup
    const result = await sql.begin(async (tx: any) => {
      const [user] = await tx`
        insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
        values (${email}, ${encrypted_password}, now(), ${tx.json({ workspace_name })})
        returning id, email, created_at`;

      const [workspace] = await tx`
        insert into admin.workspaces (slug, name, owner_id)
        values (${wsSlug}, ${workspace_name}, ${user.id})
        returning id, slug, name`;

      await tx`
        insert into admin.workspace_members (workspace_id, user_id, role)
        values (${workspace.id}, ${user.id}, 'owner')`;

      const [project] = await tx`
        insert into admin.projects (name, slug, owner_id, workspace_id)
        values (${workspace_name}, ${projectSlug}, ${user.id}, ${workspace.id})
        returning id, slug, name`;

      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-anon', ${anon.hash}, ${anon.prefix}, 'anon')`;
      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-service-role', ${svc.hash}, ${svc.prefix}, 'service_role')`;

      let corsAdded = false;
      if (initial_domain) {
        await tx`
          insert into admin.cors_origins (workspace_id, origin, description, enabled)
          values (${workspace.id}, ${initial_domain.toLowerCase()}, 'Added at signup', true)
          on conflict (workspace_id, origin) do update set enabled = true`;
        corsAdded = true;
      }

      await tx`
        insert into admin.audit_log (actor_id, project_id, action, resource_type, resource_id, params)
        values (${user.id}, ${project.id}, 'signup_full', 'user', ${user.id}::text,
                ${tx.json({ workspace: workspace.slug, initial_domain: initial_domain ?? null })})`;

      return { user, workspace, project, corsAdded };
    });

    // Seed demo data (outside tx — uses SECURITY DEFINER function)
    if (seed_demo) {
      try {
        await sql`select admin.seed_demo_data(${result.project.id}::uuid)`;
      } catch (e: any) {
        req.log.warn({ err: e.message }, 'demo seed failed');
      }
    }

    if (result.corsAdded) invalidateCorsCache();

    // Enqueue welcome email
    const siteUrl = process.env.SITE_URL || 'https://backend-joy.lovable.app';
    const apiUrl = process.env.PUBLIC_API_URL || `https://${req.hostname}`;
    try {
      await sql`
        insert into admin.email_queue (to_email, subject, html, template)
        values (${email},
                ${'Welcome to Pluto — ' + result.workspace.name},
                ${welcomeEmailHtml({
                  workspace: result.workspace.name,
                  anonKey: anon.key,
                  apiUrl,
                  loginUrl: siteUrl,
                })},
                'welcome')`;
    } catch (e: any) {
      req.log.warn({ err: e.message }, 'welcome email enqueue failed');
    }

    return reply.code(201).send({
      user: { id: result.user.id, email: result.user.email },
      workspace: result.workspace,
      project: result.project,
      keys: { anon: anon.key, service_role: svc.key },
      cors_added: result.corsAdded,
      demo_schema: seed_demo ? `demo_${result.project.id.replace(/-/g, '')}` : null,
    });
  });

  // --- GET /admin/v1/projects/:id/domains ---
  app.get<{ Params: { id: string } }>('/admin/v1/projects/:id/domains', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [project] = await sql<any[]>`
      select owner_id, workspace_id from admin.projects where id = ${req.params.id}`;
    if (!project) return reply.code(404).send({ error: 'not_found' });
    // Find owner's workspace to scope domains
    const [ws] = await sql<any[]>`
      select id from admin.workspaces
      where id = ${project.workspace_id} or owner_id = ${project.owner_id}
      order by (id = ${project.workspace_id}) desc, created_at asc limit 1`;
    if (!ws) return reply.send({ items: [] });
    await requireWorkspaceRole(cfg, ws.id, actor.userId, actor.isSuperadmin,
      ['owner', 'admin', 'developer', 'viewer']);
    const rows = await sql`
      select id, origin, description, enabled, created_at
      from admin.cors_origins
      where workspace_id = ${ws.id}
      order by created_at desc`;
    return reply.send({ items: rows, workspace_id: ws.id });
  });

  // --- POST /admin/v1/projects/:id/domains ---
  app.post<{ Params: { id: string } }>('/admin/v1/projects/:id/domains', async (req, reply) => {
    const body = z.object({
      origin: originSchema,
      description: z.string().max(500).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', issues: body.error.issues });

    const actor = await requireAuth(req, cfg);
    const sql = getSql(cfg);
    const [project] = await sql<any[]>`
      select owner_id, workspace_id from admin.projects where id = ${req.params.id}`;
    if (!project) return reply.code(404).send({ error: 'not_found' });
    const [ws] = await sql<any[]>`
      select id from admin.workspaces
      where id = ${project.workspace_id} or owner_id = ${project.owner_id}
      order by (id = ${project.workspace_id}) desc, created_at asc limit 1`;
    if (!ws) return reply.code(404).send({ error: 'workspace_not_found' });
    await requireWorkspaceRole(cfg, ws.id, actor.userId, actor.isSuperadmin, ['owner', 'admin']);

    const [row] = await sql`
      insert into admin.cors_origins (workspace_id, origin, description, enabled)
      values (${ws.id}, ${body.data.origin.toLowerCase()}, ${body.data.description ?? null}, true)
      on conflict (workspace_id, origin) do update
        set enabled = true, description = coalesce(excluded.description, admin.cors_origins.description)
      returning id, origin, description, enabled, created_at`;

    invalidateCorsCache();

    await sql`
      insert into admin.audit_log (actor_id, project_id, action, resource_type, resource_id, params)
      values (${actor.userId}, ${req.params.id}, 'domain_add', 'cors_origin', ${row.id}::text,
              ${sql.json({ origin: row.origin })})`;

    return reply.code(201).send({ item: row });
  });

  // --- DELETE /admin/v1/projects/:id/domains/:oid ---
  app.delete<{ Params: { id: string; oid: string } }>(
    '/admin/v1/projects/:id/domains/:oid',
    async (req, reply) => {
      const actor = await requireAuth(req, cfg);
      const sql = getSql(cfg);
      const [project] = await sql<any[]>`
        select owner_id, workspace_id from admin.projects where id = ${req.params.id}`;
      if (!project) return reply.code(404).send({ error: 'not_found' });
      const [ws] = await sql<any[]>`
        select id from admin.workspaces
        where id = ${project.workspace_id} or owner_id = ${project.owner_id}
        order by (id = ${project.workspace_id}) desc, created_at asc limit 1`;
      if (!ws) return reply.code(404).send({ error: 'workspace_not_found' });
      await requireWorkspaceRole(cfg, ws.id, actor.userId, actor.isSuperadmin, ['owner', 'admin']);

      await sql`
        delete from admin.cors_origins
        where id = ${req.params.oid} and workspace_id = ${ws.id}`;
      invalidateCorsCache();
      await sql`
        insert into admin.audit_log (actor_id, project_id, action, resource_type, resource_id, params)
        values (${actor.userId}, ${req.params.id}, 'domain_remove', 'cors_origin', ${req.params.oid}, '{}')`;
      return reply.send({ ok: true });
    },
  );
}
