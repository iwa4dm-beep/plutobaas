// Phase 31 — Auth completion plugin.
//
// Adds password reset, email confirmation, and phone/SMS OTP flows to the
// existing /auth/v1 surface. Enabled by default; individual pathways gate
// on env flags so integrators opt in per capability.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import argon2 from "argon2";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken } from "../../lib/jwt.js";
import { requireApiKey } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";
import { emailProvider, passwordResetEmail, emailConfirmEmail } from "../../lib/email-provider.js";
import { smsProvider } from "../../lib/sms-provider.js";

const RESET_TTL_MIN   = 30;
const CONFIRM_TTL_MIN = 60 * 24;   // 24h
const OTP_TTL_MIN     = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_SEND_WINDOW_MIN = 60;
const OTP_MAX_SENDS_PER_WINDOW = 5;

const enabled           = process.env.PLUTO_ENABLE_AUTH_COMPLETION !== "0";
const requireConfirm    = process.env.PLUTO_REQUIRE_EMAIL_CONFIRM === "1";
const smsEnabled        = process.env.PLUTO_ENABLE_SMS_OTP === "1";

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }
function frontendBase(req: FastifyRequest): string {
  const configured = process.env.PLUTO_APP_URL;
  if (configured) return configured.replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  const host  = req.headers["x-forwarded-host"] ?? req.headers.host;
  return `${proto}://${host}`;
}

async function issueSession(user: { id: string; email: string; role: "admin" | "user" }) {
  const access_token = await signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refresh_token = randomBytes(32).toString("hex");
  await db.insertInto("refresh_tokens").values({
    id: crypto.randomUUID(),
    user_id: user.id,
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

function e164(v: string): string | null {
  const cleaned = v.replace(/[^\d+]/g, "");
  return /^\+[1-9]\d{6,14}$/.test(cleaned) ? cleaned : null;
}

export async function authCompletionPlugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);

  // -------------------- Password reset --------------------
  //
  // Always returns 200 (no user enumeration). If the address exists,
  // enqueues a reset email with a single-use token valid for 30 min.
  app.post("/auth/v1/recover", async (req, reply) => {
    const body = z.object({ email: z.string().email().max(255) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();

    const user = await db.selectFrom("users").select(["id", "email"]).where("email", "=", email).executeTakeFirst();
    if (user) {
      const token = randomBytes(32).toString("base64url");
      await db.insertInto("password_reset_tokens" as never).values({
        user_id: user.id,
        token_hash: sha256(token),
        expires_at: new Date(Date.now() + RESET_TTL_MIN * 60_000),
        requested_ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip,
      } as never).execute();
      const link = `${frontendBase(req)}/auth/reset-password#token=${token}`;
      const msg = { ...passwordResetEmail(link, RESET_TTL_MIN), to: user.email };
      try { await emailProvider().send(msg); }
      catch (e) { app.log.error({ err: (e as Error).message }, "password_reset_email_failed"); }
      await log("auth", "info", `password reset requested ${email}`, user.id);
    } else {
      // Constant-time-ish: still burn a hash cycle so timing doesn't leak existence.
      await argon2.hash(randomBytes(16).toString("hex"), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 }).catch(() => undefined);
    }
    return reply.send({ ok: true });
  });

  app.post("/auth/v1/verify-recovery", async (req, reply) => {
    const body = z.object({
      token: z.string().min(20).max(200),
      new_password: z.string().min(8).max(200),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const row = await db.selectFrom("password_reset_tokens" as never)
      .select(["id" as never, "user_id" as never, "expires_at" as never, "used_at" as never])
      .where("token_hash" as never, "=", sha256(body.data.token) as never)
      .executeTakeFirst() as { id: string; user_id: string; expires_at: Date; used_at: Date | null } | undefined;
    if (!row || row.used_at || row.expires_at.getTime() < Date.now()) {
      return reply.code(400).send({ error: "invalid_or_expired_token" });
    }

    const password_hash = await argon2.hash(body.data.new_password,
      { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });

    await db.updateTable("users").set({ password_hash }).where("id", "=", row.user_id).execute();
    await db.updateTable("password_reset_tokens" as never)
      .set({ used_at: new Date() } as never)
      .where("id" as never, "=", row.id as never).execute();
    // Revoke every outstanding session — force fresh sign-in with new password.
    await db.updateTable("refresh_tokens").set({ revoked_at: new Date() })
      .where("user_id", "=", row.user_id).where("revoked_at", "is", null).execute();

    const user = await db.selectFrom("users").select(["id", "email", "role"])
      .where("id", "=", row.user_id).executeTakeFirst();
    if (!user) return reply.code(500).send({ error: "user_missing" });

    const session = await issueSession(user);
    await log("auth", "info", `password reset completed ${user.email}`, user.id);
    return { ok: true, session };
  });

  // -------------------- Email confirmation --------------------

  app.post("/auth/v1/send-email-confirmation", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    const userId = req.auth.user.sub;
    const user = await db.selectFrom("users").select(["id", "email", "email_confirm_sent_at" as never, "email_confirmed_at" as never])
      .where("id", "=", userId).executeTakeFirst() as
        | { id: string; email: string; email_confirm_sent_at: Date | null; email_confirmed_at: Date | null } | undefined;
    if (!user) return reply.code(404).send({ error: "not_found" });
    if (user.email_confirmed_at) return reply.send({ ok: true, already_confirmed: true });

    // Simple 60s cooldown to stop resend flooding.
    if (user.email_confirm_sent_at && Date.now() - user.email_confirm_sent_at.getTime() < 60_000) {
      return reply.code(429).send({ error: "cooldown", retry_after_sec: 60 });
    }

    const token = randomBytes(32).toString("base64url");
    await db.updateTable("users").set({
      email_confirm_token_hash: sha256(token),
      email_confirm_sent_at: new Date(),
    } as never).where("id", "=", userId).execute();

    const link = `${frontendBase(req)}/auth/confirm-email#token=${token}`;
    const msg = { ...emailConfirmEmail(link, CONFIRM_TTL_MIN), to: user.email };
    try { await emailProvider().send(msg); }
    catch (e) { app.log.error({ err: (e as Error).message }, "email_confirm_send_failed"); }
    return { ok: true };
  });

  app.post("/auth/v1/confirm-email", async (req, reply) => {
    const body = z.object({ token: z.string().min(20).max(200) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const hash = sha256(body.data.token);

    const row = await db.selectFrom("users")
      .select(["id", "email", "role", "email_confirm_sent_at" as never])
      .where("email_confirm_token_hash" as never, "=", hash as never)
      .executeTakeFirst() as
        | { id: string; email: string; role: "admin" | "user"; email_confirm_sent_at: Date | null } | undefined;
    if (!row) return reply.code(400).send({ error: "invalid_or_expired_token" });
    if (row.email_confirm_sent_at && Date.now() - row.email_confirm_sent_at.getTime() > CONFIRM_TTL_MIN * 60_000) {
      return reply.code(400).send({ error: "invalid_or_expired_token" });
    }

    await db.updateTable("users").set({
      email_verified: true,
      email_confirmed_at: new Date(),
      email_confirm_token_hash: null,
    } as never).where("id", "=", row.id).execute();
    await log("auth", "info", `email confirmed ${row.email}`, row.id);
    return { ok: true };
  });

  app.post("/auth/v1/resend-confirmation", async (req, reply) => {
    const body = z.object({ email: z.string().email().max(255) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const email = body.data.email.toLowerCase();
    const user = await db.selectFrom("users")
      .select(["id", "email", "email_confirm_sent_at" as never, "email_confirmed_at" as never])
      .where("email", "=", email).executeTakeFirst() as
        | { id: string; email: string; email_confirm_sent_at: Date | null; email_confirmed_at: Date | null } | undefined;
    if (!user || user.email_confirmed_at) return { ok: true }; // no enumeration
    if (user.email_confirm_sent_at && Date.now() - user.email_confirm_sent_at.getTime() < 60_000) {
      return reply.code(429).send({ error: "cooldown", retry_after_sec: 60 });
    }
    const token = randomBytes(32).toString("base64url");
    await db.updateTable("users").set({
      email_confirm_token_hash: sha256(token), email_confirm_sent_at: new Date(),
    } as never).where("id", "=", user.id).execute();
    const link = `${frontendBase(req)}/auth/confirm-email#token=${token}`;
    try { await emailProvider().send({ ...emailConfirmEmail(link, CONFIRM_TTL_MIN), to: user.email }); }
    catch (e) { app.log.error({ err: (e as Error).message }, "email_confirm_send_failed"); }
    return { ok: true };
  });

  app.get("/auth/v1/config", async () => ({
    require_email_confirmation: requireConfirm,
    sms_otp_enabled: smsEnabled,
    email_provider: emailProvider().name,
    sms_provider: smsProvider().name,
  }));

  // -------------------- Phone / SMS OTP --------------------

  app.post("/auth/v1/otp/send", async (req, reply) => {
    if (!smsEnabled) return reply.code(404).send({ error: "sms_otp_disabled" });
    const body = z.object({
      phone: z.string().min(6).max(20),
      channel: z.enum(["sms", "whatsapp"]).default("sms"),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const phone = e164(body.data.phone);
    if (!phone) return reply.code(400).send({ error: "invalid_phone" });

    // Rate limit: max 5 sends per phone per hour.
    const since = new Date(Date.now() - OTP_SEND_WINDOW_MIN * 60_000);
    const sent = await db.selectFrom("phone_otp_codes" as never)
      .select(db.fn.count<string>("id" as never).as("n"))
      .where("phone" as never, "=", phone as never)
      .where("created_at" as never, ">=", since as never)
      .executeTakeFirst() as { n: string } | undefined;
    if (Number(sent?.n ?? 0) >= OTP_MAX_SENDS_PER_WINDOW) {
      return reply.code(429).send({ error: "rate_limited", retry_after_sec: OTP_SEND_WINDOW_MIN * 60 });
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await db.insertInto("phone_otp_codes" as never).values({
      phone, code_hash: sha256(code), channel: body.data.channel,
      expires_at: new Date(Date.now() + OTP_TTL_MIN * 60_000),
      requested_ip: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip,
    } as never).execute();

    try {
      await smsProvider().send({
        to: phone,
        channel: body.data.channel,
        body: `Your verification code is ${code}. It expires in ${OTP_TTL_MIN} minutes.`,
      });
    } catch (e) {
      app.log.error({ err: (e as Error).message }, "otp_send_failed");
      return reply.code(502).send({ error: "sms_send_failed" });
    }
    return { ok: true, ttl_sec: OTP_TTL_MIN * 60 };
  });

  app.post("/auth/v1/otp/verify", async (req, reply) => {
    if (!smsEnabled) return reply.code(404).send({ error: "sms_otp_disabled" });
    const body = z.object({
      phone: z.string().min(6).max(20),
      code:  z.string().regex(/^\d{6}$/),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const phone = e164(body.data.phone);
    if (!phone) return reply.code(400).send({ error: "invalid_phone" });

    // Newest non-consumed OTP for this phone.
    const row = await db.selectFrom("phone_otp_codes" as never)
      .select(["id" as never, "code_hash" as never, "expires_at" as never,
               "attempts" as never, "consumed_at" as never])
      .where("phone" as never, "=", phone as never)
      .where("consumed_at" as never, "is", null as never)
      .orderBy("created_at" as never, "desc")
      .limit(1)
      .executeTakeFirst() as
        | { id: string; code_hash: string; expires_at: Date; attempts: number; consumed_at: Date | null } | undefined;
    if (!row || row.expires_at.getTime() < Date.now()) {
      return reply.code(400).send({ error: "invalid_or_expired_code" });
    }
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: "too_many_attempts" });
    }
    if (row.code_hash !== sha256(body.data.code)) {
      await db.updateTable("phone_otp_codes" as never)
        .set({ attempts: row.attempts + 1 } as never)
        .where("id" as never, "=", row.id as never).execute();
      return reply.code(400).send({ error: "invalid_or_expired_code" });
    }

    // Consume the code.
    await db.updateTable("phone_otp_codes" as never)
      .set({ consumed_at: new Date() } as never)
      .where("id" as never, "=", row.id as never).execute();

    // Find-or-create user for this phone.
    let user = await db.selectFrom("users").select(["id", "email", "role"])
      .where("phone" as never, "=", phone as never).executeTakeFirst() as
        | { id: string; email: string; role: "admin" | "user" } | undefined;
    if (!user) {
      const id = crypto.randomUUID();
      // Placeholder email — schema requires NOT NULL. Users can attach a real
      // email later via a linking flow; the placeholder is unique per phone.
      const placeholderEmail = `phone+${phone.replace(/[^\d]/g, "")}@phone.pluto.local`;
      await db.insertInto("users").values({
        id,
        email: placeholderEmail,
        password_hash: "!otp",
        role: "user",
        email_verified: false,
        phone,
        phone_confirmed_at: new Date(),
        created_at: new Date(),
      } as never).execute();
      user = { id, email: placeholderEmail, role: "user" };
    } else {
      await db.updateTable("users")
        .set({ phone_confirmed_at: new Date() } as never)
        .where("id", "=", user.id).execute();
    }
    const session = await issueSession(user);
    await log("auth", "info", `otp sign-in ${phone}`, user.id);
    return { session };
  });
}

/**
 * Optional preHandler: reject the request when the caller has an
 * unconfirmed email address AND `PLUTO_REQUIRE_EMAIL_CONFIRM=1`.
 */
export async function requireEmailConfirmed(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!requireConfirm) return;
  const sub = req.auth?.user?.sub;
  if (!sub) return reply.code(401).send({ error: "unauthenticated" });
  const row = await db.selectFrom("users").select(["email_confirmed_at" as never])
    .where("id", "=", sub).executeTakeFirst() as { email_confirmed_at: Date | null } | undefined;
  if (!row?.email_confirmed_at) reply.code(403).send({ error: "email_not_confirmed" });
}
