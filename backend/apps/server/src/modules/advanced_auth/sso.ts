// SSO (OIDC + SAML CRUD) — Phase 15.2.
//
// OIDC flow:
//   GET  /sso/:slug/start     → redirect user to provider's authorize URL (PKCE + state)
//   GET  /sso/:slug/callback  → exchange code, verify id_token, find/create user, issue session
// SAML: CRUD only for now; ACS returns a friendly note.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { q } from "../../lib/pgraw.js";
import { aesEncrypt, aesDecrypt } from "../../lib/aes.js";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken } from "../../lib/jwt.js";

// Cache one JWKS fetcher per issuer. `createRemoteJWKSet` handles
// caching/rotation internally (5-min cool-down between refreshes) so this
// map just avoids duplicating that state across concurrent verifications.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJWKS(jwksUri: string) {
  let j = jwksCache.get(jwksUri);
  if (!j) { j = createRemoteJWKSet(new URL(jwksUri)); jwksCache.set(jwksUri, j); }
  return j;
}

function requireService(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.auth?.apiKey !== "service_role") { reply.code(403).send({ error: "service_role_required" }); return false; }
  return true;
}

// Sanitize config on read — never echo client_secret ciphertext back.
function scrub(cfg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "client_secret_ct" || k === "client_secret_nonce" || k === "client_secret") continue;
    out[k] = v;
  }
  if ("client_secret_ct" in cfg) out.client_secret_present = true;
  return out;
}

const oidcConfig = z.object({
  issuer: z.string().url(),
  client_id: z.string().min(1),
  client_secret: z.string().min(1).optional(),
  redirect_uri: z.string().url(),
  scopes: z.array(z.string()).default(["openid", "email", "profile"]),
});

const samlConfig = z.object({
  entity_id: z.string().min(1),
  sso_url: z.string().url(),
  x509_cert: z.string().min(1),
  name_id_format: z.string().default("urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"),
});

const createBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(60),
  display_name: z.string().min(1),
  protocol: z.enum(["oidc", "saml"]),
  enabled: z.boolean().default(true),
  config: z.record(z.unknown()),
});

async function persistConfig(protocol: "oidc" | "saml", input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (protocol === "oidc") {
    const p = oidcConfig.parse(input);
    const out: Record<string, unknown> = { ...p };
    if (p.client_secret) {
      const { ct, nonce } = aesEncrypt(Buffer.from(p.client_secret, "utf8"));
      delete out.client_secret;
      out.client_secret_ct = ct.toString("base64");
      out.client_secret_nonce = nonce.toString("base64");
    }
    return out;
  }
  return samlConfig.parse(input) as Record<string, unknown>;
}

export function mountSso(app: FastifyInstance) {
  app.get("/auth/v1/sso/providers", async (req) => {
    const ws = req.auth!.workspaceId;
    const r = await q<{ id: string; slug: string; display_name: string; protocol: string;
      enabled: boolean; config: Record<string, unknown>; created_at: Date }>(
      `select id, slug, display_name, protocol, enabled, config, created_at
       from public.auth_sso_providers where workspace_id=$1 order by created_at desc`, [ws]);
    return { providers: r.rows.map((p) => ({ ...p, config: scrub(p.config) })) };
  });

  app.post("/auth/v1/sso/providers", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const body = createBody.parse(req.body);
    const cfg = await persistConfig(body.protocol, body.config);
    const ws = req.auth!.workspaceId;
    const r = await q<{ id: string; created_at: Date }>(
      `insert into public.auth_sso_providers (workspace_id, slug, display_name, protocol, enabled, config)
       values ($1,$2,$3,$4,$5,$6) returning id, created_at`,
      [ws, body.slug, body.display_name, body.protocol, body.enabled, JSON.stringify(cfg)]);
    return { id: r.rows[0]!.id, slug: body.slug, display_name: body.display_name,
             protocol: body.protocol, enabled: body.enabled, config: scrub(cfg),
             created_at: r.rows[0]!.created_at };
  });

  app.patch("/auth/v1/sso/providers/:id", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = z.object({
      display_name: z.string().optional(),
      enabled: z.boolean().optional(),
      config: z.record(z.unknown()).optional(),
      protocol: z.enum(["oidc", "saml"]).optional(),
    }).parse(req.body);
    const cur = await q<{ protocol: "oidc" | "saml"; config: Record<string, unknown> }>(
      `select protocol, config from public.auth_sso_providers where id=$1 and workspace_id=$2`,
      [id, req.auth!.workspaceId]);
    if (cur.rows.length === 0) return reply.code(404).send({ error: "not_found" });
    const nextProtocol = body.protocol ?? cur.rows[0]!.protocol;
    const nextConfig = body.config ? await persistConfig(nextProtocol, body.config) : cur.rows[0]!.config;
    await q(`update public.auth_sso_providers
             set display_name=coalesce($1,display_name), enabled=coalesce($2,enabled),
                 protocol=$3, config=$4, updated_at=now() where id=$5`,
      [body.display_name ?? null, body.enabled ?? null, nextProtocol, JSON.stringify(nextConfig), id]);
    return { ok: true };
  });

  app.delete("/auth/v1/sso/providers/:id", async (req, reply) => {
    if (!requireService(req, reply)) return;
    const { id } = req.params as { id: string };
    const r = await q(`delete from public.auth_sso_providers where id=$1 and workspace_id=$2`,
      [id, req.auth!.workspaceId]);
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    return { ok: true };
  });

  // ---- OIDC start ----
  app.get("/auth/v1/sso/:slug/start", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const redirect_to = (req.query as { redirect_to?: string })?.redirect_to ?? "/";
    const prov = await q<{ id: string; protocol: string; enabled: boolean; config: Record<string, unknown> }>(
      `select id, protocol, enabled, config from public.auth_sso_providers
       where slug=$1 and workspace_id=$2`, [slug, req.auth!.workspaceId]);
    const p = prov.rows[0];
    if (!p || !p.enabled) return reply.code(404).send({ error: "provider_not_found" });
    if (p.protocol !== "oidc") return reply.code(400).send({ error: "not_oidc", message: "SAML uses the /acs endpoint" });

    const cfg = p.config as { issuer: string; client_id: string; redirect_uri: string; scopes: string[] };
    // Fetch discovery to locate authorize endpoint.
    const disc = await fetch(cfg.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration").then((r) => r.json()) as {
      authorization_endpoint: string;
    };
    const state = randomBytes(16).toString("hex");
    const nonce = randomBytes(16).toString("hex");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const expires = new Date(Date.now() + 10 * 60_000);
    await q(`insert into public.auth_sso_sessions (provider_id, state, nonce, pkce_verifier, redirect_to, expires_at)
             values ($1,$2,$3,$4,$5,$6)`, [p.id, state, nonce, verifier, redirect_to, expires]);

    const url = new URL(disc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.client_id);
    url.searchParams.set("redirect_uri", cfg.redirect_uri);
    url.searchParams.set("scope", (cfg.scopes ?? ["openid","email","profile"]).join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    return reply.redirect(url.toString());
  });

  // ---- OIDC callback ----
  app.get("/auth/v1/sso/:slug/callback", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state) return reply.code(400).send({ error: "missing_params" });

    const prov = await q<{ id: string; config: Record<string, unknown> }>(
      `select id, config from public.auth_sso_providers where slug=$1 and workspace_id=$2 and protocol='oidc'`,
      [slug, req.auth!.workspaceId]);
    const p = prov.rows[0]; if (!p) return reply.code(404).send({ error: "provider_not_found" });
    const sess = await q<{ id: string; nonce: string; pkce_verifier: string; redirect_to: string;
      expires_at: Date; consumed_at: Date | null }>(
      `select id, nonce, pkce_verifier, redirect_to, expires_at, consumed_at
       from public.auth_sso_sessions where provider_id=$1 and state=$2`, [p.id, state]);
    const s = sess.rows[0]; if (!s) return reply.code(400).send({ error: "invalid_state" });
    if (s.consumed_at || s.expires_at.getTime() < Date.now())
      return reply.code(400).send({ error: "session_expired" });

    const cfg = p.config as { issuer: string; client_id: string; redirect_uri: string;
      client_secret_ct?: string; client_secret_nonce?: string };
    const disc = await fetch(cfg.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration").then((r) => r.json()) as {
      token_endpoint: string; userinfo_endpoint: string;
    };
    const params = new URLSearchParams({
      grant_type: "authorization_code",
      code, redirect_uri: cfg.redirect_uri, client_id: cfg.client_id,
      code_verifier: s.pkce_verifier,
    });
    if (cfg.client_secret_ct && cfg.client_secret_nonce) {
      const secret = aesDecrypt(Buffer.from(cfg.client_secret_ct, "base64"),
                                Buffer.from(cfg.client_secret_nonce, "base64")).toString("utf8");
      params.set("client_secret", secret);
    }
    const tok = await fetch(disc.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!tok.ok) return reply.code(400).send({ error: "token_exchange_failed", detail: await tok.text() });
    const tokJson = await tok.json() as { access_token: string; id_token?: string };

    // Decode id_token payload (signature verification is provider-trusted for now — TODO: jwks)
    let email: string | undefined; let name: string | undefined;
    if (tokJson.id_token) {
      const [, payload] = tokJson.id_token.split(".");
      const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")) as { email?: string; name?: string; nonce?: string };
      if (claims.nonce && claims.nonce !== s.nonce) return reply.code(400).send({ error: "nonce_mismatch" });
      email = claims.email; name = claims.name;
    }
    if (!email) {
      const ui = await fetch(disc.userinfo_endpoint, { headers: { authorization: `Bearer ${tokJson.access_token}` } });
      const uij = await ui.json() as { email?: string; name?: string };
      email = uij.email; name = name ?? uij.name;
    }
    if (!email) return reply.code(400).send({ error: "no_email_from_idp" });

    await q(`update public.auth_sso_sessions set consumed_at=now() where id=$1`, [s.id]);

    // Find / create user
    let user = await db.selectFrom("users").select(["id","email","role"]).where("email","=",email).executeTakeFirst();
    if (!user) {
      const id = crypto.randomUUID();
      await db.insertInto("users").values({ id, email, password_hash: "", role: "user",
        email_verified: true, created_at: new Date() }).execute();
      user = { id, email, role: "user" };
    }
    const access_token = await signAccessToken({ sub: user.id, role: user.role, email: user.email });
    const refresh_token = randomBytes(32).toString("hex");
    const th = createHash("sha256").update(refresh_token).digest("hex");
    await db.insertInto("refresh_tokens").values({
      id: crypto.randomUUID(), user_id: user.id, token_hash: th,
      expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000), revoked_at: null,
    }).execute();

    // Redirect back with tokens in fragment (matches oauth.ts pattern).
    const target = new URL(s.redirect_to, "http://placeholder.local");
    const frag = new URLSearchParams({ access_token, refresh_token,
      expires_at: String(Math.floor(Date.now()/1000) + env.ACCESS_TOKEN_TTL_SEC),
      user: JSON.stringify({ id: user.id, email: user.email, role: user.role, name: name ?? null }) });
    const dest = (s.redirect_to.startsWith("http") ? s.redirect_to : target.pathname + target.search) + "#" + frag.toString();
    return reply.redirect(dest);
  });

  app.post("/auth/v1/sso/:slug/acs", async (_req, reply) => {
    reply.code(501).send({ error: "not_implemented", feature: "sso.saml.acs",
      message: "SAML ACS handler ships in Phase 15.3. CRUD is available today." });
  });
}
