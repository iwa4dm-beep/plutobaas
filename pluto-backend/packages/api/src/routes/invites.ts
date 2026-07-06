// Phase 16 · Admin invites — superadmin creates a shell customer and sends
// them an invite link. The user clicks the link, sets their password, and
// gets an already-configured workspace + project + keys.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

const emailSchema = z.string().trim().toLowerCase().email().max(255);
const INVITE_TTL_HOURS = 48;

function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';
  return `${base}-${randomBytes(3).toString('hex')}`;
}

function mintApiKey(role: 'anon' | 'service_role') {
  const prefix = role === 'service_role' ? 'pluto_sk_' : 'pluto_pk_';
  const key = prefix + randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(key).digest('hex');
  return { key, prefix: key.slice(0, 12), hash };
}

async function requireSuperadmin(req: FastifyRequest, cfg: Config): Promise<string> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  const sql = getSql(cfg);
  const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${decoded.sub}`;
  if (!u?.is_superadmin) { const e: any = new Error('Forbidden'); e.statusCode = 403; throw e; }
  return decoded.sub;
}

function inviteEmailHtml(opts: { link: string; workspace: string }): string {
  return `
  <div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
    <h1 style="font-size:22px;margin:0 0 8px">You have been invited to Pluto</h1>
    <p style="color:#475569">A workspace named <b>${opts.workspace}</b> is ready for you. Click the button to set your password.</p>
    <p><a href="${opts.link}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Accept invite</a></p>
    <p style="font-size:12px;color:#64748b">Link expires in ${INVITE_TTL_HOURS} hours. If you did not expect this, ignore this email.</p>
  </div>`;
}

export async function invitesRoutes(app: FastifyInstance, cfg: Config) {
  // --- POST /admin/v1/invite  (superadmin only) ---
  app.post('/admin/v1/invite', async (req, reply) => {
    const inviterId = await requireSuperadmin(req, cfg);
    const body = z.object({
      email: emailSchema,
      workspace_name: z.string().trim().min(2).max(80),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', issues: body.error.issues });

    const { email, workspace_name } = body.data;
    const sql = getSql(cfg);
    const dup = await sql`select id from auth.users where lower(email) = ${email}`;
    if (dup.length) return reply.code(409).send({ error: 'user_already_exists' });

    const anon = mintApiKey('anon');
    const svc = mintApiKey('service_role');
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const wsSlug = slugify(workspace_name);
    const projectSlug = slugify(workspace_name);

    const invite = await sql.begin(async (tx: any) => {
      // Shell user (no password yet — set on accept)
      const [user] = await tx`
        insert into auth.users (email, raw_user_meta_data)
        values (${email}, ${tx.json({ invited_by: inviterId, workspace_name })})
        returning id`;
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
        returning id, slug`;
      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-anon', ${anon.hash}, ${anon.prefix}, 'anon')`;
      await tx`
        insert into admin.api_keys (project_id, name, key_hash, key_prefix, role)
        values (${project.id}, 'default-service-role', ${svc.hash}, ${svc.prefix}, 'service_role')`;
      const [inv] = await tx`
        insert into admin.invites (email, workspace_id, project_id, token_hash, invited_by, expires_at)
        values (${email}, ${workspace.id}, ${project.id}, ${tokenHash}, ${inviterId},
                now() + (${INVITE_TTL_HOURS} || ' hours')::interval)
        returning id, expires_at`;
      await tx`
        insert into admin.audit_log (actor_id, project_id, action, resource_type, resource_id, params)
        values (${inviterId}, ${project.id}, 'invite_created', 'invite', ${inv.id}::text,
                ${tx.json({ email, workspace: workspace.slug })})`;
      return { user, workspace, project, inv };
    });

    const siteUrl = process.env.SITE_URL || 'https://backend-joy.lovable.app';
    const link = `${siteUrl}/accept-invite?token=${encodeURIComponent(token)}`;
    await sql`
      insert into admin.email_queue (to_email, subject, html, template)
      values (${email}, 'You have been invited to Pluto',
              ${inviteEmailHtml({ link, workspace: workspace_name })}, 'invite')`;

    return reply.code(201).send({
      invite_id: invite.inv.id,
      expires_at: invite.inv.expires_at,
      workspace: invite.workspace,
      project: invite.project,
      // Return link so superadmin can share it manually if email fails
      invite_link: link,
    });
  });

  // --- POST /auth/v1/accept-invite ---
  app.post('/auth/v1/accept-invite', async (req, reply) => {
    const body = z.object({
      token: z.string().min(20),
      password: z.string().min(8).max(72),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', issues: body.error.issues });

    const sql = getSql(cfg);
    const tokenHash = createHash('sha256').update(body.data.token).digest('hex');
    const [inv] = await sql<any[]>`
      select id, email, workspace_id, project_id, accepted_at, expires_at
      from admin.invites where token_hash = ${tokenHash}`;
    if (!inv) return reply.code(404).send({ error: 'invite_not_found' });
    if (inv.accepted_at) return reply.code(409).send({ error: 'invite_already_used' });
    if (new Date(inv.expires_at).getTime() < Date.now()) {
      return reply.code(410).send({ error: 'invite_expired' });
    }

    const encrypted = await argon2.hash(body.data.password, { type: argon2.argon2id });
    await sql.begin(async (tx: any) => {
      await tx`
        update auth.users
        set encrypted_password = ${encrypted}, email_confirmed_at = now()
        where lower(email) = ${inv.email}`;
      await tx`
        update admin.invites set accepted_at = now() where id = ${inv.id}`;
    });

    const [user] = await sql<any[]>`
      select id, email, role, raw_user_meta_data, raw_app_meta_data
      from auth.users where lower(email) = ${inv.email}`;
    const access_token = await (app as any).jwt.sign(
      { sub: user.id, email: user.email, role: user.role || 'authenticated', aud: 'authenticated' },
      { expiresIn: cfg.JWT_ACCESS_TTL },
    );
    return reply.send({
      access_token,
      user: { id: user.id, email: user.email },
      workspace_id: inv.workspace_id,
      project_id: inv.project_id,
    });
  });
}
