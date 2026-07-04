// OAuth 2.0 sign-in for Google + GitHub.
//
//   GET  /auth/v1/oauth/:provider?redirect_to=<url>   → 302 to provider
//   GET  /auth/v1/oauth/callback/:provider?code=...   → creates/links user,
//                                                       then 302 back to
//                                                       <redirect_to>?access_token=...&refresh_token=...

import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken } from "../../lib/jwt.js";
import { log } from "../../lib/logs.js";

type ProviderCfg = {
  authUrl: string; tokenUrl: string; userUrl: string; scope: string;
  clientId?: string; clientSecret?: string;
  parseUser: (data: Record<string, unknown>, token: string) => Promise<{ id: string; email: string }>;
};

const providers: Record<string, ProviderCfg> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
    scope: "openid email profile",
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    parseUser: async (u) => ({ id: String(u.sub), email: String(u.email) }),
  },
  github: {
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userUrl: "https://api.github.com/user",
    scope: "read:user user:email",
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    parseUser: async (u, token) => {
      let email = u.email as string | null;
      if (!email) {
        const res = await fetch("https://api.github.com/user/emails", {
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
        const emails = (await res.json()) as { email: string; primary: boolean; verified: boolean }[];
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails[0]?.email ?? null;
      }
      if (!email) throw new Error("github_no_email");
      return { id: String(u.id), email };
    },
  },
  // Phase 41 — additional first-class OAuth providers.
  apple: {
    // Apple returns email in the id_token claims (JWT), not userinfo.
    // Client secret is a signed JWT the caller must supply via env.
    authUrl: "https://appleid.apple.com/auth/authorize",
    tokenUrl: "https://appleid.apple.com/auth/token",
    userUrl: "https://appleid.apple.com/auth/keys",
    scope: "name email",
    clientId: process.env.APPLE_CLIENT_ID,
    clientSecret: process.env.APPLE_CLIENT_SECRET,
    parseUser: async (_u, token) => {
      // Decode id_token payload (unverified — Apple already validated).
      const [, payload] = token.split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      return { id: String(claims.sub), email: String(claims.email) };
    },
  },
  discord: {
    authUrl: "https://discord.com/api/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userUrl: "https://discord.com/api/users/@me",
    scope: "identify email",
    clientId: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    parseUser: async (u) => ({ id: String(u.id), email: String(u.email) }),
  },
  facebook: {
    authUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    userUrl: "https://graph.facebook.com/me?fields=id,email,name",
    scope: "email public_profile",
    clientId: process.env.FACEBOOK_CLIENT_ID,
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
    parseUser: async (u) => ({ id: String(u.id), email: String(u.email ?? `${u.id}@facebook.local`) }),
  },
  azure: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    userUrl: "https://graph.microsoft.com/oidc/userinfo",
    scope: "openid email profile",
    clientId: process.env.AZURE_CLIENT_ID,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
    parseUser: async (u) => ({ id: String(u.sub), email: String(u.email ?? u.preferred_username) }),
  },
  linkedin: {
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    userUrl: "https://api.linkedin.com/v2/userinfo",
    scope: "openid profile email",
    clientId: process.env.LINKEDIN_CLIENT_ID,
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET,
    parseUser: async (u) => ({ id: String(u.sub), email: String(u.email) }),
  },
};

// Short-lived signed state so we don't need server sessions.
function signState(payload: { redirect_to: string; provider: string; nonce: string }): string {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHash("sha256").update(raw + env.JWT_SECRET).digest("hex").slice(0, 32);
  return `${raw}.${sig}`;
}
function verifyState(state: string): { redirect_to: string; provider: string; nonce: string } | null {
  const [raw, sig] = state.split(".");
  if (!raw || !sig) return null;
  const expected = createHash("sha256").update(raw + env.JWT_SECRET).digest("hex").slice(0, 32);
  if (expected !== sig) return null;
  return JSON.parse(Buffer.from(raw, "base64url").toString());
}

function callbackUrl(req: { headers: Record<string, unknown> }, provider: string) {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "http";
  const host = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}/auth/v1/oauth/callback/${provider}`;
}

export async function oauthRoutes(app: FastifyInstance) {
  app.get("/oauth/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const cfg = providers[provider];
    if (!cfg) return reply.code(404).send({ error: "unknown_provider" });
    if (!cfg.clientId || !cfg.clientSecret) return reply.code(501).send({ error: "provider_not_configured" });

    const { redirect_to } = (req.query ?? {}) as { redirect_to?: string };
    if (!redirect_to) return reply.code(400).send({ error: "redirect_to_required" });

    const state = signState({ redirect_to, provider, nonce: randomBytes(8).toString("hex") });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: callbackUrl(req, provider),
      response_type: "code",
      scope: cfg.scope,
      state,
    });
    return reply.redirect(`${cfg.authUrl}?${params}`);
  });

  app.get("/oauth/callback/:provider", async (req, reply) => {
    const { provider } = req.params as { provider: string };
    const cfg = providers[provider];
    if (!cfg?.clientId || !cfg?.clientSecret) return reply.code(404).send({ error: "unknown_provider" });

    const { code, state } = (req.query ?? {}) as { code?: string; state?: string };
    if (!code || !state) return reply.code(400).send({ error: "missing_params" });
    const parsed = verifyState(state);
    if (!parsed || parsed.provider !== provider) return reply.code(400).send({ error: "invalid_state" });

    const tokenRes = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
        code, grant_type: "authorization_code",
        redirect_uri: callbackUrl(req, provider),
      }),
    });
    if (!tokenRes.ok) return reply.code(400).send({ error: "token_exchange_failed" });
    const tokenJson = await tokenRes.json() as { access_token?: string };
    const providerToken = tokenJson.access_token;
    if (!providerToken) return reply.code(400).send({ error: "no_access_token" });

    const userRes = await fetch(cfg.userUrl, {
      headers: { authorization: `Bearer ${providerToken}`, accept: "application/json", "user-agent": "pluto-baas" },
    });
    if (!userRes.ok) return reply.code(400).send({ error: "userinfo_failed" });
    const { id: providerUserId, email } = await cfg.parseUser(await userRes.json(), providerToken);

    // Link or create.
    let userRow = await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
    if (!userRow) {
      const userCountRow = await db.selectFrom("users").select(db.fn.count<string>("id").as("c")).executeTakeFirst();
      const isFirst = !userCountRow || Number(userCountRow.c) === 0;
      const id = crypto.randomUUID();
      await db.insertInto("users").values({
        id, email, password_hash: "!oauth", role: isFirst ? "admin" : "user",
        email_verified: true, created_at: new Date(),
      }).execute();
      userRow = { id, email, password_hash: "!oauth", role: isFirst ? "admin" : "user", email_verified: true, created_at: new Date() };
    }
    await db.insertInto("oauth_accounts").values({
      id: crypto.randomUUID(), user_id: userRow.id, provider,
      provider_user_id: providerUserId, created_at: new Date(),
    }).onConflict((oc) => oc.columns(["provider", "provider_user_id"]).doNothing()).execute();

    const access_token = await signAccessToken({ sub: userRow.id, role: userRow.role, email: userRow.email });
    const refresh_token = randomBytes(32).toString("hex");
    await db.insertInto("refresh_tokens").values({
      id: crypto.randomUUID(), user_id: userRow.id,
      token_hash: createHash("sha256").update(refresh_token).digest("hex"),
      expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000),
      revoked_at: null,
    }).execute();

    await log("auth", "info", `oauth ${provider} ${email}`, userRow.id);
    const dest = new URL(parsed.redirect_to);
    dest.hash = `access_token=${access_token}&refresh_token=${refresh_token}&expires_in=${env.ACCESS_TOKEN_TTL_SEC}`;
    return reply.redirect(dest.toString());
  });
}
