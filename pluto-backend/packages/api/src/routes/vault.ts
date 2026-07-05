// Vault & Secrets: envelope encryption (KEK -> DEK -> ciphertext), versioning, rotation, audit, dynamic DB creds.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

function getKek(cfg: Config): Buffer {
  const raw = (cfg as any).PLUTO_VAULT_KEK || process.env.PLUTO_VAULT_KEK || cfg.PLUTO_JWT_SECRET;
  return createHash('sha256').update(String(raw)).digest();
}
function wrap(kek: Buffer, plaintext: Buffer) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}
function unwrap(kek: Buffer, blob: Buffer) {
  const iv = blob.subarray(0, 12), tag = blob.subarray(12, 28), ct = blob.subarray(28);
  const d = createDecipheriv('aes-256-gcm', kek, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function encWithDek(dek: Buffer, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { iv, ciphertext: ct, tag: c.getAuthTag() };
}
function decWithDek(dek: Buffer, iv: Buffer, ct: Buffer, tag: Buffer) {
  const d = createDecipheriv('aes-256-gcm', dek, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

async function ensureKey(cfg: Config, projectId: string, alias = 'default') {
  const sql = getSql(cfg);
  const [existing] = await sql<any[]>`select * from admin.vault_keys where project_id = ${projectId} and alias = ${alias}`;
  if (existing) return existing;
  const dek = randomBytes(32);
  const wrapped = wrap(getKek(cfg), dek);
  const [row] = await sql<any[]>`
    insert into admin.vault_keys (project_id, alias, wrapped_dek) values (${projectId}, ${alias}, ${wrapped}) returning *`;
  return row;
}

export async function vaultRoutes(app: FastifyInstance, cfg: Config) {
  const sql = getSql(cfg);

  // ---------- Keys ----------
  app.get('/admin/v1/vault/keys', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return sql`select id, alias, kek_id, algo, created_at, rotated_at from admin.vault_keys where project_id = ${q.project_id} order by alias`;
  });

  app.post('/admin/v1/vault/keys/rotate', async (req) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({ project_id: z.string().uuid(), alias: z.string().default('default') }).parse(req.body);
    const kek = getKek(cfg);
    const [key] = await sql<any[]>`select * from admin.vault_keys where project_id = ${body.project_id} and alias = ${body.alias}`;
    if (!key) throw new Error('key not found');
    const oldDek = unwrap(kek, key.wrapped_dek);
    const newDek = randomBytes(32);
    // Re-encrypt every current-version secret ciphertext with the new DEK
    const versions = await sql<any[]>`
      select v.* from admin.vault_secret_versions v
      join admin.vault_secrets s on s.id = v.secret_id and v.version = s.current_version
      where v.key_id = ${key.id} and s.project_id = ${body.project_id}`;
    for (const v of versions) {
      const plain = decWithDek(oldDek, v.iv, v.ciphertext, v.tag);
      const e = encWithDek(newDek, plain);
      await sql`update admin.vault_secret_versions set iv = ${e.iv}, ciphertext = ${e.ciphertext}, tag = ${e.tag} where id = ${v.id}`;
    }
    const wrapped = wrap(kek, newDek);
    await sql`update admin.vault_keys set wrapped_dek = ${wrapped}, rotated_at = now() where id = ${key.id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'vault.key.rotate', target: key.id, detail: { rewrapped: versions.length } });
    return { ok: true, rewrapped: versions.length };
  });

  // ---------- Secrets ----------
  app.get('/admin/v1/vault/secrets', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), environment: z.string().optional() }).parse(req.query);
    return sql`
      select id, name, environment, current_version, description, created_at, updated_at
      from admin.vault_secrets
      where project_id = ${q.project_id}
        ${q.environment ? sql`and environment = ${q.environment}` : sql``}
      order by environment, name`;
  });

  app.post('/admin/v1/vault/secrets', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      environment: z.enum(['development','staging','production']).default('production'),
      name: z.string().min(1).max(120),
      value: z.string().min(1),
      description: z.string().optional(),
    }).parse(req.body);

    const key = await ensureKey(cfg, body.project_id);
    const dek = unwrap(getKek(cfg), key.wrapped_dek);
    const enc = encWithDek(dek, body.value);

    const [secret] = await sql<any[]>`
      insert into admin.vault_secrets (project_id, environment, name, description)
      values (${body.project_id}, ${body.environment}, ${body.name}, ${body.description ?? null})
      on conflict (project_id, environment, name) do update
        set current_version = admin.vault_secrets.current_version + 1,
            description = coalesce(excluded.description, admin.vault_secrets.description),
            updated_at = now()
      returning *`;

    await sql`
      insert into admin.vault_secret_versions (secret_id, version, key_id, iv, ciphertext, tag, created_by)
      values (${secret.id}, ${secret.current_version}, ${key.id}, ${enc.iv}, ${enc.ciphertext}, ${enc.tag}, ${actor.userId})`;

    await sql`insert into admin.vault_access_log (secret_id, version, actor_id, action) values (${secret.id}, ${secret.current_version}, ${actor.userId}, 'write')`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'vault.secret.write', target: secret.name, detail: { env: body.environment, version: secret.current_version } });
    reply.code(201).send({ id: secret.id, name: secret.name, environment: secret.environment, version: secret.current_version });
  });

  app.get('/admin/v1/vault/secrets/:id/versions', async (req) => {
    await requireAuth(req, cfg);
    const { id } = req.params as any;
    return sql`select id, version, created_at, created_by from admin.vault_secret_versions where secret_id = ${id} order by version desc`;
  });

  app.post('/admin/v1/vault/secrets/:id/reveal', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ version: z.number().int().optional() }).parse(req.body ?? {});
    const [secret] = await sql<any[]>`select * from admin.vault_secrets where id = ${id}`;
    if (!secret) throw new Error('not found');
    const version = body.version ?? secret.current_version;
    const [ver] = await sql<any[]>`select * from admin.vault_secret_versions where secret_id = ${id} and version = ${version}`;
    if (!ver) throw new Error('version not found');
    const [key] = await sql<any[]>`select * from admin.vault_keys where id = ${ver.key_id}`;
    const dek = unwrap(getKek(cfg), key.wrapped_dek);
    const value = decWithDek(dek, ver.iv, ver.ciphertext, ver.tag);
    await sql`insert into admin.vault_access_log (secret_id, version, actor_id, action, ip) values (${id}, ${version}, ${actor.userId}, 'read', ${req.ip})`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'vault.secret.read', target: secret.name, detail: { version } });
    return { name: secret.name, environment: secret.environment, version, value };
  });

  app.post('/admin/v1/vault/secrets/:id/rotate', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const body = z.object({ value: z.string().min(1) }).parse(req.body);
    const [secret] = await sql<any[]>`select * from admin.vault_secrets where id = ${id}`;
    if (!secret) throw new Error('not found');
    const key = await ensureKey(cfg, secret.project_id);
    const dek = unwrap(getKek(cfg), key.wrapped_dek);
    const enc = encWithDek(dek, body.value);
    const nextVersion = secret.current_version + 1;
    await sql`insert into admin.vault_secret_versions (secret_id, version, key_id, iv, ciphertext, tag, created_by)
      values (${id}, ${nextVersion}, ${key.id}, ${enc.iv}, ${enc.ciphertext}, ${enc.tag}, ${actor.userId})`;
    await sql`update admin.vault_secrets set current_version = ${nextVersion}, updated_at = now() where id = ${id}`;
    await sql`insert into admin.vault_access_log (secret_id, version, actor_id, action) values (${id}, ${nextVersion}, ${actor.userId}, 'rotate')`;
    return { ok: true, version: nextVersion };
  });

  app.delete('/admin/v1/vault/secrets/:id', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    await sql`insert into admin.vault_access_log (secret_id, actor_id, action) values (${id}, ${actor.userId}, 'delete')`;
    await sql`delete from admin.vault_secrets where id = ${id}`;
    reply.code(204).send();
  });

  app.get('/admin/v1/vault/access-log', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid(), limit: z.coerce.number().int().max(500).default(100) }).parse(req.query);
    return sql`
      select l.*, s.name, s.environment
      from admin.vault_access_log l
      join admin.vault_secrets s on s.id = l.secret_id
      where s.project_id = ${q.project_id}
      order by l.at desc limit ${q.limit}`;
  });

  // ---------- Dynamic DB credentials ----------
  app.post('/admin/v1/vault/db-credentials', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const body = z.object({
      project_id: z.string().uuid(),
      ttl_minutes: z.number().int().min(5).max(1440).default(60),
      role_prefix: z.string().default('pluto_dyn_'),
      grant_sql: z.string().optional(),
    }).parse(req.body);
    const suffix = randomBytes(6).toString('hex');
    const username = `${body.role_prefix}${suffix}`;
    const password = randomBytes(24).toString('base64url');
    const expires = new Date(Date.now() + body.ttl_minutes * 60_000);
    // Create the actual PG role (best-effort; needs the pool user to have createrole)
    try {
      await sql.unsafe(`create role "${username}" login password '${password}' valid until '${expires.toISOString()}'`);
      if (body.grant_sql) await sql.unsafe(body.grant_sql.replace(/\{role\}/g, `"${username}"`));
    } catch (e: any) {
      reply.code(500).send({ error: 'role_create_failed', message: e.message });
      return;
    }
    // Store password as a vault secret
    const key = await ensureKey(cfg, body.project_id);
    const dek = unwrap(getKek(cfg), key.wrapped_dek);
    const enc = encWithDek(dek, password);
    const [secret] = await sql<any[]>`
      insert into admin.vault_secrets (project_id, environment, name, description)
      values (${body.project_id}, 'production', ${'dyn_db_' + suffix}, 'Dynamic DB credential')
      returning *`;
    await sql`insert into admin.vault_secret_versions (secret_id, version, key_id, iv, ciphertext, tag, created_by)
      values (${secret.id}, 1, ${key.id}, ${enc.iv}, ${enc.ciphertext}, ${enc.tag}, ${actor.userId})`;
    const [row] = await sql<any[]>`
      insert into admin.vault_db_credentials (project_id, role_prefix, username, password_secret_id, expires_at)
      values (${body.project_id}, ${body.role_prefix}, ${username}, ${secret.id}, ${expires.toISOString()})
      returning *`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'vault.dyn_cred.issue', target: username, detail: { ttl_minutes: body.ttl_minutes } });
    reply.code(201).send({ ...row, password });
  });

  app.get('/admin/v1/vault/db-credentials', async (req) => {
    await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    return sql`select id, username, expires_at, revoked_at, created_at from admin.vault_db_credentials
      where project_id = ${q.project_id} order by created_at desc limit 100`;
  });

  app.post('/admin/v1/vault/db-credentials/:id/revoke', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = req.params as any;
    const [row] = await sql<any[]>`select * from admin.vault_db_credentials where id = ${id}`;
    if (!row) throw new Error('not found');
    try { await sql.unsafe(`drop role if exists "${row.username}"`); } catch { /* ignore */ }
    await sql`update admin.vault_db_credentials set revoked_at = now() where id = ${id}`;
    await logAudit(cfg, { actor_id: actor.userId, action: 'vault.dyn_cred.revoke', target: row.username });
    return { ok: true };
  });
}
