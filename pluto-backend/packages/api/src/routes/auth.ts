import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import argon2 from 'argon2';
import { z } from 'zod';
import { randomBytes, createHash } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

const emailSchema = z.string().trim().toLowerCase().email().max(255);
const passwordSchema = z.string().min(8).max(72);

const signupBody = z.object({
  email: emailSchema,
  password: passwordSchema,
  data: z.record(z.any()).optional(),
});

const passwordGrant = z.object({
  grant_type: z.literal('password'),
  email: emailSchema,
  password: passwordSchema,
});

const refreshGrant = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().min(20),
});

const tokenBody = z.discriminatedUnion('grant_type', [passwordGrant, refreshGrant]);

const recoverBody = z.object({ email: emailSchema });
const updateUserBody = z.object({
  password: passwordSchema.optional(),
  email: emailSchema.optional(),
  data: z.record(z.any()).optional(),
});

function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

async function issueSession(app: FastifyInstance, cfg: Config, user: any, parent?: string) {
  const sql = getSql(cfg);
  const access_token = await app.jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role || 'authenticated',
      aud: 'authenticated',
      user_metadata: user.raw_user_meta_data || {},
      app_metadata: user.raw_app_meta_data || {},
    },
    { expiresIn: cfg.JWT_ACCESS_TTL }
  );
  const refresh = newRefreshToken();
  const refresh_hash = hashToken(refresh);
  const expires_at = new Date(Date.now() + cfg.JWT_REFRESH_TTL * 1000);
  await sql`
    INSERT INTO auth.refresh_tokens (user_id, token, parent, expires_at)
    VALUES (${user.id}, ${refresh_hash}, ${parent ?? null}, ${expires_at})
  `;
  return {
    access_token,
    token_type: 'bearer',
    expires_in: cfg.JWT_ACCESS_TTL,
    expires_at: Math.floor(Date.now() / 1000) + cfg.JWT_ACCESS_TTL,
    refresh_token: refresh,
    user: publicUser(user),
  };
}

function publicUser(u: any) {
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    email_confirmed_at: u.email_confirmed_at,
    last_sign_in_at: u.last_sign_in_at,
    role: u.role,
    user_metadata: u.raw_user_meta_data || {},
    app_metadata: u.raw_app_meta_data || {},
    created_at: u.created_at,
    updated_at: u.updated_at,
  };
}

async function requireBearer(app: FastifyInstance, req: FastifyRequest, reply: FastifyReply) {
  const h = req.headers.authorization;
  if (!h || !h.toLowerCase().startsWith('bearer ')) {
    reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
    return null;
  }
  try {
    const payload = await app.jwt.verify<any>(h.slice(7));
    return payload;
  } catch (e: any) {
    reply.code(401).send({ error: 'unauthorized', message: e.message });
    return null;
  }
}

export async function authRoutes(app: FastifyInstance, cfg: Config) {
  const sql = getSql(cfg);

  // --- POST /auth/v1/signup ---
  app.post('/auth/v1/signup', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    const { email, password, data } = parsed.data;

    const existing = await sql`SELECT id FROM auth.users WHERE lower(email) = ${email} LIMIT 1`;
    if (existing.length) return reply.code(409).send({ error: 'user_already_exists', message: 'Email already registered' });

    const encrypted_password = await argon2.hash(password, { type: argon2.argon2id });
    const [user] = await sql`
      INSERT INTO auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at)
      VALUES (${email}, ${encrypted_password}, ${sql.json(data || {})}, now())
      RETURNING *
    `;
    const session = await issueSession(app, cfg, user);
    reply.code(201).send(session);
  });

  // --- POST /auth/v1/token?grant_type=password | refresh_token ---
  app.post('/auth/v1/token', {
    config: { rateLimit: { max: cfg.RATE_LIMIT_AUTH, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const merged = { ...(req.query as any), ...(req.body as any) };
    const parsed = tokenBody.safeParse(merged);
    if (!parsed.success) return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });

    if (parsed.data.grant_type === 'password') {
      const { email, password } = parsed.data;
      const [user] = await sql`SELECT * FROM auth.users WHERE lower(email) = ${email} LIMIT 1`;
      if (!user || !user.encrypted_password) {
        return reply.code(400).send({ error: 'invalid_grant', message: 'Invalid login credentials' });
      }
      const ok = await argon2.verify(user.encrypted_password, password);
      if (!ok) return reply.code(400).send({ error: 'invalid_grant', message: 'Invalid login credentials' });
      await sql`UPDATE auth.users SET last_sign_in_at = now() WHERE id = ${user.id}`;
      const session = await issueSession(app, cfg, user);
      return reply.send(session);
    }

    // refresh_token grant
    const { refresh_token } = parsed.data;
    const rHash = hashToken(refresh_token);
    const [row] = await sql`
      SELECT rt.*, u.* FROM auth.refresh_tokens rt
      JOIN auth.users u ON u.id = rt.user_id
      WHERE rt.token = ${rHash} LIMIT 1
    `;
    if (!row) return reply.code(400).send({ error: 'invalid_grant', message: 'Invalid refresh token' });
    if (row.revoked) {
      // Reuse detection — revoke entire family
      await sql`UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = ${row.user_id}`;
      return reply.code(400).send({ error: 'invalid_grant', message: 'Refresh token reuse detected; session revoked' });
    }
    if (new Date(row.expires_at) < new Date()) {
      return reply.code(400).send({ error: 'invalid_grant', message: 'Refresh token expired' });
    }
    // Rotate
    await sql`UPDATE auth.refresh_tokens SET revoked = true WHERE token = ${rHash}`;
    const user = { ...row, id: row.user_id };
    const session = await issueSession(app, cfg, user, rHash);
    return reply.send(session);
  });

  // --- POST /auth/v1/logout ---
  app.post('/auth/v1/logout', async (req, reply) => {
    const claims = await requireBearer(app, req, reply);
    if (!claims) return;
    await sql`UPDATE auth.refresh_tokens SET revoked = true WHERE user_id = ${claims.sub} AND revoked = false`;
    return reply.code(204).send();
  });

  // --- GET /auth/v1/user ---
  app.get('/auth/v1/user', async (req, reply) => {
    const claims = await requireBearer(app, req, reply);
    if (!claims) return;
    const [user] = await sql`SELECT * FROM auth.users WHERE id = ${claims.sub} LIMIT 1`;
    if (!user) return reply.code(404).send({ error: 'not_found' });
    return reply.send(publicUser(user));
  });

  // --- PUT /auth/v1/user ---
  app.put('/auth/v1/user', async (req, reply) => {
    const claims = await requireBearer(app, req, reply);
    if (!claims) return;
    const parsed = updateUserBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    const patch: Record<string, any> = { updated_at: new Date() };
    if (parsed.data.email) patch.email = parsed.data.email;
    if (parsed.data.data) patch.raw_user_meta_data = parsed.data.data;
    if (parsed.data.password) patch.encrypted_password = await argon2.hash(parsed.data.password, { type: argon2.argon2id });
    const [user] = await sql`
      UPDATE auth.users SET ${sql(patch)} WHERE id = ${claims.sub} RETURNING *
    `;
    return reply.send(publicUser(user));
  });

  // --- POST /auth/v1/recover (password recovery — email delivery TBD) ---
  app.post('/auth/v1/recover', {
    config: { rateLimit: { max: 3, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = recoverBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'validation', issues: parsed.error.issues });
    // Silent success — do not reveal user existence. Real email delivery lands with SMTP plugin.
    app.log.info({ recover_for: parsed.data.email }, 'password recovery requested');
    return reply.send({ ok: true });
  });

  // --- GET /auth/v1/settings ---
  app.get('/auth/v1/settings', async () => ({
    external: { email: true, phone: false },
    disable_signup: false,
    mailer_autoconfirm: true,
  }));

  // --- GET /auth/v1/jwks (symmetric HS256 — placeholder empty JWKS) ---
  // NOTE: Phase 2 uses HS256. Phase 4 will switch to RS256 and publish real keys here.
  app.get('/auth/v1/jwks', async () => ({ keys: [] }));
}
