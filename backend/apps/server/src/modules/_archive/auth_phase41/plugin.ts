// Phase 41 — Auth completeness plugin.
//
// Adds three flows on top of the existing /auth/v1 surface:
//   POST /auth/v1/magic-link                  → email a one-time login link
//   GET  /auth/v1/magic-link/verify?token=…   → consume + issue session (redirect)
//   POST /auth/v1/anonymous                   → creates guest user + session
//   POST /auth/v1/link-anonymous              → binds a guest user to an
//                                                email+password (auth required)
//
// Every path fires the matching auth-hook lifecycle event. All routes
// protected by requireApiKey (same as the other auth surfaces).

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import argon2 from "argon2";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken } from "../../lib/jwt.js";
import { requireApiKey } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";
import { emailProvider } from "../../lib/email-provider.js";
import { dispatchAfter, dispatchBefore } from "../../lib/auth-hooks.js";

const MAGIC_TTL_MIN = 15;
const enabled = process.env.PLUTO_ENABLE_AUTH_PHASE41 !== "0";

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }
function appBase(req: FastifyRequest): string {
  const configured = process.env.PLUTO_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  const host  = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

async function issueSession(user: { id: string; email: string; role: "admin" | "user" }) {
  const access_token  = await signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refresh_token = randomBytes(32).toString("hex");
  await db.insertInto("refresh_tokens").values({
    id: crypto.randomUUID(), user_id: user.id,
    token_hash: sha256(refresh_token),
    expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000),
    revoked_at: null,
  }).execute();
  return {
    access_token, refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + env.ACCESS_TOKEN_TTL_SEC,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function authPhase41Plugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // -------------------- Magic link --------------------
  app.post("/auth/v1/magic-link", async (req, reply) => {
    const body = z.object({
      email: z.string().email().max(255),
      redirect_to: z.string().url().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();

    const veto = await dispatchBefore("before_signin", { email, kind: "magic_link" });
    if (!veto.allow) return reply.code(403).send({ error: "hook_denied", reason: veto.reason });

    // Silently succeed even if the user doesn't exist (no enumeration).
    const user = await db.selectFrom("users").select(["id", "email"]).where("email", "=", email).executeTakeFirst();
    if (user) {
      const token = randomBytes(32).toString("base64url");
      await db.insertInto("magic_link_tokens" as never).values({
        user_id: user.id, email,
        token_hash: sha256(token),
        expires_at: new Date(Date.now() + MAGIC_TTL_MIN * 60_000),
        requested_ip: req.ip,
      } as never).execute();

      const link = `${appBase(req)}/auth/v1/magic-link/verify?token=${token}` +
                   (body.data.redirect_to ? `&redirect_to=${encodeURIComponent(body.data.redirect_to)}` : "");
      await emailProvider().send({
        to: email,
        subject: "Your sign-in link",
        text: `Click to sign in (valid for ${MAGIC_TTL_MIN} min):\n\n${link}\n`,
        html: `<p>Click to sign in (valid for ${MAGIC_TTL_MIN} min):</p><p><a href="${link}">${link}</a></p>`,
      });
      await log("auth", "info", `magic-link sent ${email}`, user.id);
    }
    return { ok: true };
  });

  app.get("/auth/v1/magic-link/verify", async (req, reply) => {
    const q = z.object({ token: z.string().min(10), redirect_to: z.string().url().optional() })
      .safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_token" });

    const hashed = sha256(q.data.token);
    const row = await db.selectFrom("magic_link_tokens" as never).selectAll()
      .where("token_hash" as never, "=", hashed as never).executeTakeFirst() as
      | { id: string; user_id: string; email: string; expires_at: Date; used_at: Date | null } | undefined;
    if (!row || row.used_at || row.expires_at < new Date()) {
      return reply.code(401).send({ error: "invalid_or_expired" });
    }
    await db.updateTable("magic_link_tokens" as never)
      .set({ used_at: new Date() } as never)
      .where("id" as never, "=", row.id as never).execute();

    const user = await db.selectFrom("users").selectAll().where("id", "=", row.user_id).executeTakeFirst();
    if (!user) return reply.code(404).send({ error: "user_not_found" });
    const session = await issueSession({ id: user.id, email: user.email, role: user.role });
    dispatchAfter("after_magic_link", { user_id: user.id, email: user.email });
    await log("auth", "info", `magic-link consumed ${user.email}`, user.id);

    if (q.data.redirect_to) {
      const dest = new URL(q.data.redirect_to);
      dest.hash = `access_token=${session.access_token}&refresh_token=${session.refresh_token}&expires_in=${env.ACCESS_TOKEN_TTL_SEC}`;
      return reply.redirect(dest.toString());
    }
    return { session };
  });

  // -------------------- Anonymous sign-in --------------------
  app.post("/auth/v1/anonymous", async (req, reply) => {
    const veto = await dispatchBefore("before_signup", { kind: "anonymous" });
    if (!veto.allow) return reply.code(403).send({ error: "hook_denied", reason: veto.reason });

    const id = crypto.randomUUID();
    const email = `anon-${id}@guest.pluto.local`;
    await db.insertInto("users").values({
      id, email, password_hash: "!anonymous", role: "user",
      email_verified: false, created_at: new Date(),
      is_anonymous: true,
    } as never).execute();
    const session = await issueSession({ id, email, role: "user" });
    dispatchAfter("after_anonymous_signin", { user_id: id });
    await log("auth", "info", `anonymous sign-in ${id}`, id);
    return { user: { id, email, role: "user", is_anonymous: true }, session };
  });

  // -------------------- Link anonymous → permanent --------------------
  app.post("/auth/v1/link-anonymous", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    const body = z.object({
      email: z.string().email().max(255),
      password: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const uid = req.auth.user.sub;
    const cur = await db.selectFrom("users").selectAll().where("id", "=", uid).executeTakeFirst();
    if (!cur) return reply.code(404).send({ error: "user_not_found" });
    if (!(cur as unknown as { is_anonymous?: boolean }).is_anonymous) {
      return reply.code(409).send({ error: "not_anonymous" });
    }
    const clash = await db.selectFrom("users").select("id").where("email", "=", body.data.email.toLowerCase()).executeTakeFirst();
    if (clash) return reply.code(409).send({ error: "email_taken" });

    const password_hash = await argon2.hash(body.data.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
    await db.updateTable("users").set({
      email: body.data.email.toLowerCase(),
      password_hash,
      is_anonymous: false,
    } as never).where("id", "=", uid).execute();

    dispatchAfter("after_signup", { user_id: uid, email: body.data.email.toLowerCase(), linked_from: "anonymous" });
    await log("auth", "info", `linked anon → ${body.data.email}`, uid);
    return { ok: true, user: { id: uid, email: body.data.email.toLowerCase(), role: cur.role, is_anonymous: false } };
  });
}
