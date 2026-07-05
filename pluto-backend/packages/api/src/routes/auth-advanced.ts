import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';
import { logAudit } from '../audit/logger.js';

// ---------------------- TOTP (RFC 6238) — no deps ----------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf: Buffer): string {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s: string): Buffer {
  s = s.replace(/=+$/g, '').toUpperCase();
  let bits = '';
  for (const c of s) {
    const i = B32.indexOf(c);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secretB32: string, step = 30, digits = 6, at = Date.now()): string {
  const counter = Math.floor(at / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', b32decode(secretB32)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24 |
                (hmac[offset + 1] & 0xff) << 16 |
                (hmac[offset + 2] & 0xff) << 8  |
                (hmac[offset + 3] & 0xff)) % 10 ** digits;
  return code.toString().padStart(digits, '0');
}
function verifyTotp(secret: string, code: string, window = 1): boolean {
  const now = Date.now();
  for (let i = -window; i <= window; i++) {
    if (totp(secret, 30, 6, now + i * 30_000) === code) return true;
  }
  return false;
}

// ---------------------- routes ----------------------

const oauthBody = z.object({
  project_id: z.string().uuid(),
  provider: z.enum(['google', 'github', 'apple', 'azure', 'discord', 'facebook', 'custom']),
  client_id: z.string().min(3),
  client_secret: z.string().min(3),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string()).default(['openid', 'email', 'profile']),
  enabled: z.boolean().default(true),
});

const samlBody = z.object({
  project_id: z.string().uuid(),
  name: z.string().min(1),
  entity_id: z.string().min(1),
  sso_url: z.string().url(),
  x509_cert: z.string().min(20),
  attribute_mapping: z.record(z.string()).optional(),
  enabled: z.boolean().default(true),
});

// Provider metadata for OAuth authorize URLs
const OAUTH_AUTHZ: Record<string, string> = {
  google: 'https://accounts.google.com/o/oauth2/v2/auth',
  github: 'https://github.com/login/oauth/authorize',
  apple:  'https://appleid.apple.com/auth/authorize',
  azure:  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  discord:'https://discord.com/oauth2/authorize',
  facebook:'https://www.facebook.com/v18.0/dialog/oauth',
};
const OAUTH_TOKEN: Record<string, string> = {
  google: 'https://oauth2.googleapis.com/token',
  github: 'https://github.com/login/oauth/access_token',
  apple:  'https://appleid.apple.com/auth/token',
  azure:  'https://login.microsoftonline.com/common/oauth2/v2.0/token',
  discord:'https://discord.com/api/oauth2/token',
  facebook:'https://graph.facebook.com/v18.0/oauth/access_token',
};
const OAUTH_USERINFO: Record<string, string> = {
  google:  'https://openidconnect.googleapis.com/v1/userinfo',
  github:  'https://api.github.com/user',
  apple:   '', // apple returns id_token in the token response
  azure:   'https://graph.microsoft.com/oidc/userinfo',
  discord: 'https://discord.com/api/users/@me',
  facebook:'https://graph.facebook.com/me?fields=id,name,email',
};

export async function authAdvancedRoutes(app: FastifyInstance, cfg: Config) {
  // ==================== OAUTH PROVIDER CRUD ====================
  app.get('/admin/v1/oauth/providers', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select id, provider, client_id, redirect_uri, scopes, enabled, created_at
        from admin.oauth_providers where project_id = ${q.project_id}`;
  });

  app.post('/admin/v1/oauth/providers', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = oauthBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const [row] = await sql`
      insert into admin.oauth_providers
        (project_id, provider, client_id, client_secret, redirect_uri, scopes, enabled)
      values (${b.project_id}, ${b.provider}, ${b.client_id}, ${b.client_secret},
              ${b.redirect_uri}, ${b.scopes}, ${b.enabled})
      on conflict (project_id, provider)
      do update set client_id=excluded.client_id, client_secret=excluded.client_secret,
                    redirect_uri=excluded.redirect_uri, scopes=excluded.scopes, enabled=excluded.enabled
      returning id, provider, client_id, redirect_uri, scopes, enabled, created_at`;
    await logAudit(cfg, {
      actor_id: actor.userId, project_id: b.project_id,
      action: 'oauth.provider.upsert', resource_type: 'oauth_provider',
      resource_id: row.id, params: { provider: b.provider },
    });
    return row;
  });

  app.delete('/admin/v1/oauth/providers/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sql = getSql(cfg);
    const [p] = await sql`select project_id from admin.oauth_providers where id=${id}`;
    if (!p) return { ok: true };
    await requireProjectRole(cfg, p.project_id, actor, ['owner', 'admin']);
    await sql`delete from admin.oauth_providers where id=${id}`;
    return { ok: true };
  });

  // ==================== OAUTH SIGN-IN FLOW ====================
  // /auth/v1/oauth/:provider/authorize?project_id=...
  app.get('/auth/v1/oauth/:provider/authorize', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { project_id } = z.object({ project_id: z.string().uuid() }).parse(req.query);
    const sql = getSql(cfg);
    const [p] = await sql`
      select * from admin.oauth_providers
       where project_id=${project_id} and provider=${provider} and enabled=true`;
    if (!p) return reply.code(404).send({ error: 'provider_not_configured' });
    const state = randomBytes(24).toString('base64url');
    // Store state hash briefly (5min) — reuse mfa_challenges? Use audit_log for simplicity.
    await sql`insert into admin.audit_log (action, resource_type, resource_id, params)
              values ('oauth.state.issue', 'oauth_state', ${state},
                      ${sql.json({ project_id, provider })})`;
    const authz = OAUTH_AUTHZ[provider];
    if (!authz) return reply.code(400).send({ error: 'unsupported_provider' });
    const url = new URL(authz);
    url.searchParams.set('client_id', p.client_id);
    url.searchParams.set('redirect_uri', p.redirect_uri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', p.scopes.join(' '));
    url.searchParams.set('state', state);
    reply.redirect(url.toString(), 302);
  });

  // /auth/v1/oauth/:provider/callback?code=...&state=...
  app.get('/auth/v1/oauth/:provider/callback', async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const { code, state } = z.object({ code: z.string(), state: z.string() }).parse(req.query);
    const sql = getSql(cfg);
    const [ss] = await sql`
      select params from admin.audit_log
       where action='oauth.state.issue' and resource_id = ${state}
         and created_at > now() - interval '10 minutes'
       order by created_at desc limit 1`;
    if (!ss) return reply.code(400).send({ error: 'invalid_state' });
    const project_id = ss.params.project_id;
    const [p] = await sql`
      select * from admin.oauth_providers where project_id=${project_id} and provider=${provider}`;
    if (!p) return reply.code(400).send({ error: 'provider_missing' });

    // Exchange code
    const tokenUrl = OAUTH_TOKEN[provider];
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: p.redirect_uri,
        client_id: p.client_id,
        client_secret: p.client_secret,
      }).toString(),
    });
    const tok = await tokenRes.json() as any;
    if (!tokenRes.ok || !tok.access_token) {
      return reply.code(400).send({ error: 'token_exchange_failed', detail: tok });
    }

    // Fetch profile
    let profile: any = {};
    const uinfo = OAUTH_USERINFO[provider];
    if (uinfo) {
      const pr = await fetch(uinfo, { headers: { Authorization: `Bearer ${tok.access_token}` } });
      profile = await pr.json();
    }
    const email: string | undefined = profile.email || profile.mail;
    if (!email) return reply.code(400).send({ error: 'no_email_from_provider' });

    // Upsert user
    const [existing] = await sql`select id from auth.users where email = ${email}`;
    let userId = existing?.id;
    if (!userId) {
      const [u] = await sql`
        insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
        values (${email}, '', now(), ${sql.json({ provider, ...profile })})
        returning id`;
      userId = u.id;
    }
    // Mint an access token — reuse jwt if available
    const token = (app as any).jwt.sign({ sub: userId, email, provider });
    reply.header('Content-Type', 'text/html');
    return `<script>window.opener?.postMessage({type:'pluto:oauth',token:${JSON.stringify(token)}},'*');window.close();</script>
<p>Signed in. You can close this window.</p>`;
  });

  // ==================== MFA (TOTP) ====================
  app.post('/auth/v1/mfa/enroll', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = z.object({ friendly_name: z.string().default('Authenticator') }).parse(req.body ?? {});
    const sql = getSql(cfg);
    const secret = b32encode(randomBytes(20));
    const [row] = await sql`
      insert into auth.mfa_factors (user_id, factor_type, friendly_name, secret, status)
      values (${actor.userId}, 'totp', ${b.friendly_name}, ${secret}, 'unverified')
      returning id, friendly_name, status, created_at`;
    const issuer = 'Pluto';
    const [u] = await sql`select email from auth.users where id = ${actor.userId}`;
    const label = encodeURIComponent(`${issuer}:${u?.email ?? actor.userId}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&period=30&digits=6&algorithm=SHA1`;
    return { ...row, secret, otpauth_url: otpauth };
  });

  app.post('/auth/v1/mfa/verify', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const b = z.object({ factor_id: z.string().uuid(), code: z.string().length(6) }).parse(req.body);
    const sql = getSql(cfg);
    const [f] = await sql`
      select * from auth.mfa_factors where id=${b.factor_id} and user_id=${actor.userId}`;
    if (!f || f.factor_type !== 'totp' || !f.secret) return reply.code(400).send({ error: 'not_found' });
    if (!verifyTotp(f.secret, b.code)) return reply.code(400).send({ error: 'invalid_code' });
    await sql`update auth.mfa_factors set status='verified', last_used_at=now() where id=${b.factor_id}`;
    return { ok: true };
  });

  app.get('/auth/v1/mfa/factors', async (req) => {
    const actor = await requireAuth(req, cfg);
    return getSql(cfg)`
      select id, factor_type, friendly_name, status, last_used_at, created_at
        from auth.mfa_factors where user_id=${actor.userId}`;
  });

  app.delete('/auth/v1/mfa/factors/:id', async (req) => {
    const actor = await requireAuth(req, cfg);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await getSql(cfg)`delete from auth.mfa_factors where id=${id} and user_id=${actor.userId}`;
    return { ok: true };
  });

  // Step-up: challenge + verify to get an aal2 token
  app.post('/auth/v1/mfa/challenge', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = z.object({ code: z.string().length(6) }).parse(req.body);
    const sql = getSql(cfg);
    const [f] = await sql`
      select * from auth.mfa_factors
       where user_id=${actor.userId} and status='verified' and factor_type='totp' limit 1`;
    if (!f) return { error: 'no_factor' };
    if (!verifyTotp(f.secret, b.code)) return { error: 'invalid_code' };
    await sql`update auth.mfa_factors set last_used_at=now() where id=${f.id}`;
    const aal2 = (app as any).jwt.sign({
      sub: actor.userId, aal: 'aal2', amr: ['totp'],
    }, { expiresIn: '1h' });
    return { access_token: aal2, aal: 'aal2' };
  });

  // ==================== SAML SSO (metadata + ACS) ====================
  app.get('/admin/v1/saml/providers', async (req) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    return getSql(cfg)`
      select id, name, entity_id, sso_url, attribute_mapping, enabled, created_at
        from admin.saml_providers where project_id=${q.project_id}`;
  });

  app.post('/admin/v1/saml/providers', async (req) => {
    const actor = await requireAuth(req, cfg);
    const b = samlBody.parse(req.body);
    await requireProjectRole(cfg, b.project_id, actor, ['owner', 'admin']);
    const sql = getSql(cfg);
    const [row] = await sql`
      insert into admin.saml_providers
        (project_id, name, entity_id, sso_url, x509_cert, attribute_mapping, enabled)
      values (${b.project_id}, ${b.name}, ${b.entity_id}, ${b.sso_url}, ${b.x509_cert},
              ${sql.json(b.attribute_mapping ?? { email: 'email', name: 'name' })}, ${b.enabled})
      on conflict (project_id, name)
      do update set entity_id=excluded.entity_id, sso_url=excluded.sso_url,
                    x509_cert=excluded.x509_cert, attribute_mapping=excluded.attribute_mapping,
                    enabled=excluded.enabled
      returning id, name, entity_id, sso_url, attribute_mapping, enabled, created_at`;
    return row;
  });

  // Service Provider metadata (public — IdPs need it)
  app.get('/auth/v1/saml/metadata', async (req, reply) => {
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    const base = cfg.PUBLIC_API_URL ?? `http://${cfg.HOST}:${cfg.PORT}`;
    reply.header('Content-Type', 'application/xml');
    return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${base}/auth/v1/saml/metadata?project_id=${q.project_id}">
  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"
                   protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
                              Location="${base}/auth/v1/saml/acs?project_id=${q.project_id}"
                              index="0" isDefault="true"/>
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
  </SPSSODescriptor>
</EntityDescriptor>`;
  });

  // Assertion Consumer Service (minimal — real SAML lib recommended)
  app.post('/auth/v1/saml/acs', async (req, reply) => {
    const q = z.object({ project_id: z.string().uuid() }).parse(req.query);
    const body = req.body as any;
    const samlResp = body?.SAMLResponse;
    if (!samlResp) return reply.code(400).send({ error: 'missing_saml_response' });
    // Decode base64 & extract NameID (naive; production must verify signature vs stored x509_cert).
    const xml = Buffer.from(samlResp, 'base64').toString('utf8');
    const email = (xml.match(/<saml:?NameID[^>]*>([^<]+)</) ?? [])[1]
              ?? (xml.match(/<Attribute[^>]*Name="email"[^>]*>[^<]*<AttributeValue[^>]*>([^<]+)</) ?? [])[1];
    if (!email) return reply.code(400).send({ error: 'no_email_in_assertion' });

    const sql = getSql(cfg);
    // Optional: check that a saml_providers row exists for this project.
    const [providers] = await sql`
      select count(*)::int as n from admin.saml_providers
       where project_id=${q.project_id} and enabled=true`;
    if (!providers || providers.n === 0) return reply.code(400).send({ error: 'no_provider' });

    const [existing] = await sql`select id from auth.users where email = ${email}`;
    let userId = existing?.id;
    if (!userId) {
      const [u] = await sql`
        insert into auth.users (email, encrypted_password, email_confirmed_at, raw_user_meta_data)
        values (${email}, '', now(), ${sql.json({ sso: 'saml' })})
        returning id`;
      userId = u.id;
    }
    const token = (app as any).jwt.sign({ sub: userId, email, amr: ['saml'] });
    reply.header('Content-Type', 'text/html');
    return `<script>window.opener?.postMessage({type:'pluto:oauth',token:${JSON.stringify(token)}},'*');window.close();</script>
<p>Signed in via SAML.</p>`;
  });
}
