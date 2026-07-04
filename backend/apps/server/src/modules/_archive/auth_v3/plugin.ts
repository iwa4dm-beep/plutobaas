// Phase 50 — Auth v3 plugin (WebAuthn/passkeys + TOTP v2 + risk + devices).
//
// Endpoints (all under /auth/v3):
//   POST /auth/v3/passkeys/register/options   — mint registration challenge
//   POST /auth/v3/passkeys/register/verify    — persist attested credential
//   POST /auth/v3/passkeys/authenticate/options — mint assertion challenge
//   POST /auth/v3/passkeys/authenticate/verify  — verify assertion + counter
//   GET  /auth/v3/passkeys                      — list user credentials
//   DELETE /auth/v3/passkeys/:id                — revoke credential
//
//   POST /auth/v3/totp/enroll                   — generate secret + otpauth
//   POST /auth/v3/totp/verify                   — activate factor with 6-digit code
//   POST /auth/v3/totp/challenge                — step-up challenge (verify code)
//   DELETE /auth/v3/totp/:id                    — revoke factor
//   POST /auth/v3/recovery-codes/generate       — mint N single-use codes
//   POST /auth/v3/recovery-codes/consume        — consume one
//
//   POST /auth/v3/sessions/score                — compute risk score
//   GET  /auth/v3/devices                       — list trusted devices
//   PATCH /auth/v3/devices/:id                  — label / trust flag
//   DELETE /auth/v3/devices/:id                 — revoke device + sessions
//   GET  /auth/v3/sessions                      — list active sessions
//   DELETE /auth/v3/sessions/:id                — revoke session
//
// Enable with PLUTO_ENABLE_AUTH_V3=1.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { db as _kysely } from "../../../db/index.js";
import { pgPool } from "../../../lib/pgraw.js";
// Legacy shim: auth_v3 was written against a raw pg-style `.query()` API.
// Keep the name `db` but back it with the shared pg pool so we don't rewrite
// 30+ call sites during the Wave 1 boot restoration.
const db = { query: (text: string, params?: unknown[]) => pgPool.query(text, params as never) };
void _kysely;
import { requireApiKey } from "../../../lib/apikey.js";
import { audit } from "../../../lib/audit.js";
import {
  buildRegistrationOptions, buildAuthenticationOptions,
  newChallenge, checkAssertionCounter, b64url,
} from "../../../lib/webauthn.js";
import { generateTotpSecret, verifyTotp, base32Decode, otpauthUrl } from "../../../lib/totp.js";
import { scoreSession, deviceHash, type RiskSignals } from "../../../lib/risk-score.js";

const enabled = process.env.PLUTO_ENABLE_AUTH_V3 === "1";
const RP_ID   = () => process.env.PLUTO_WEBAUTHN_RP_ID   ?? "localhost";
const RP_NAME = () => process.env.PLUTO_WEBAUTHN_RP_NAME ?? "Pluto BaaS";

function requireUser(req: any): string {
  const uid = req.auth?.user?.sub;
  if (!uid) throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
  return uid as string;
}

function hashCode(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

export async function authV3Plugin(app: FastifyInstance) {
  if (!enabled) { app.log.info({ module: "auth_v3" }, "auth_v3 disabled"); return; }
  app.addHook("preHandler", requireApiKey);

  // ------------------------------------------------------------------------
  // Passkeys / WebAuthn
  // ------------------------------------------------------------------------
  app.post("/auth/v3/passkeys/register/options", async (req, reply) => {
    const uid = requireUser(req);
    const opts = buildRegistrationOptions({
      rp_id: RP_ID(), rp_name: RP_NAME(),
      user_id: uid, user_name: uid, user_display: uid,
    });
    await db.query(
      `INSERT INTO av3_webauthn_challenges (user_id, challenge, purpose, expires_at)
       VALUES ($1, $2, 'register', now() + interval '2 minutes')`,
      [uid, opts.challenge],
    );
    return opts;
  });

  app.post("/auth/v3/passkeys/register/verify", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({
      challenge:      z.string(),
      credential_id:  z.string().min(4),
      public_key_b64: z.string(),
      transports:     z.array(z.string()).default([]),
      aaguid:         z.string().nullable().optional(),
      friendly_name:  z.string().max(80).nullable().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const ch = await db.query(
      `SELECT id FROM av3_webauthn_challenges
        WHERE user_id=$1 AND challenge=$2 AND purpose='register'
          AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
      [uid, body.data.challenge],
    );
    if (ch.rowCount === 0) return reply.code(400).send({ error: "invalid_challenge" });
    await db.query(`UPDATE av3_webauthn_challenges SET consumed_at=now() WHERE id=$1`, [ch.rows[0].id]);

    const pk = Buffer.from(body.data.public_key_b64, "base64");
    const ins = await db.query(
      `INSERT INTO av3_webauthn_credentials
         (user_id, credential_id, public_key, transports, aaguid, friendly_name)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [uid, body.data.credential_id, pk, body.data.transports,
       body.data.aaguid ?? null, body.data.friendly_name ?? null],
    );
    await audit(req, { action: "passkey.register", target_id: ins.rows[0].id });
    return { id: ins.rows[0].id, created_at: ins.rows[0].created_at };
  });

  app.post("/auth/v3/passkeys/authenticate/options", async (req, reply) => {
    const uid = requireUser(req);
    const rows = await db.query(
      `SELECT credential_id, transports FROM av3_webauthn_credentials WHERE user_id=$1`,
      [uid],
    );
    const opts = buildAuthenticationOptions({
      rp_id: RP_ID(),
      allow: rows.rows.map((r: any) => ({ credential_id: r.credential_id, transports: r.transports })),
    });
    await db.query(
      `INSERT INTO av3_webauthn_challenges (user_id, challenge, purpose, expires_at)
       VALUES ($1, $2, 'authenticate', now() + interval '2 minutes')`,
      [uid, opts.challenge],
    );
    return opts;
  });

  app.post("/auth/v3/passkeys/authenticate/verify", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({
      challenge:     z.string(),
      credential_id: z.string(),
      sign_count:    z.number().int().min(0),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });

    const ch = await db.query(
      `SELECT id FROM av3_webauthn_challenges
        WHERE user_id=$1 AND challenge=$2 AND purpose='authenticate'
          AND consumed_at IS NULL AND expires_at > now() LIMIT 1`,
      [uid, body.data.challenge],
    );
    if (ch.rowCount === 0) return reply.code(400).send({ error: "invalid_challenge" });

    const cred = await db.query(
      `SELECT id, sign_count FROM av3_webauthn_credentials
        WHERE user_id=$1 AND credential_id=$2 LIMIT 1`,
      [uid, body.data.credential_id],
    );
    if (cred.rowCount === 0) return reply.code(404).send({ error: "unknown_credential" });

    const nextCount = checkAssertionCounter(Number(cred.rows[0].sign_count), body.data.sign_count);
    if (nextCount === null) return reply.code(400).send({ error: "counter_regression_possible_clone" });

    await db.query(`UPDATE av3_webauthn_challenges SET consumed_at=now() WHERE id=$1`, [ch.rows[0].id]);
    await db.query(
      `UPDATE av3_webauthn_credentials SET sign_count=$2, last_used_at=now() WHERE id=$1`,
      [cred.rows[0].id, nextCount],
    );
    await audit(req, { action: "passkey.assert", target_id: cred.rows[0].id });
    return { verified: true, sign_count: nextCount };
  });

  app.get("/auth/v3/passkeys", async (req) => {
    const uid = requireUser(req);
    const r = await db.query(
      `SELECT id, credential_id, friendly_name, transports, sign_count,
              last_used_at, created_at
         FROM av3_webauthn_credentials WHERE user_id=$1
        ORDER BY created_at DESC`,
      [uid],
    );
    return { items: r.rows };
  });

  app.delete("/auth/v3/passkeys/:id", async (req, reply) => {
    const uid = requireUser(req);
    const { id } = req.params as { id: string };
    const r = await db.query(
      `DELETE FROM av3_webauthn_credentials WHERE id=$1 AND user_id=$2`, [id, uid],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    await audit(req, { action: "passkey.revoke", target_id: id });
    return { revoked: true };
  });

  // ------------------------------------------------------------------------
  // TOTP MFA
  // ------------------------------------------------------------------------
  app.post("/auth/v3/totp/enroll", async (req) => {
    const uid = requireUser(req);
    const body = z.object({ friendly_name: z.string().max(80).optional() }).safeParse(req.body ?? {});
    const name = body.success ? body.data.friendly_name ?? null : null;
    const { secret_b32 } = generateTotpSecret();
    const ins = await db.query(
      `INSERT INTO av3_totp_factors (user_id, secret_b32, friendly_name)
       VALUES ($1,$2,$3) RETURNING id, created_at`,
      [uid, secret_b32, name],
    );
    const url = otpauthUrl(secret_b32, uid, RP_NAME());
    return {
      factor_id: ins.rows[0].id,
      secret: secret_b32,
      otpauth_url: url,
    };
  });

  app.post("/auth/v3/totp/verify", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({
      factor_id: z.string().uuid(),
      code:      z.string().regex(/^\d{6}$/),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const f = await db.query(
      `SELECT id, secret_b32, status FROM av3_totp_factors WHERE id=$1 AND user_id=$2`,
      [body.data.factor_id, uid],
    );
    if (f.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    const ok = verifyTotp(base32Decode(f.rows[0].secret_b32), body.data.code);
    if (!ok) return reply.code(400).send({ error: "invalid_code" });
    await db.query(
      `UPDATE av3_totp_factors SET status='verified', verified_at=now(), last_used_at=now() WHERE id=$1`,
      [f.rows[0].id],
    );
    await audit(req, { action: "totp.verify", target_id: f.rows[0].id });
    return { verified: true };
  });

  app.post("/auth/v3/totp/challenge", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({ code: z.string().regex(/^\d{6}$/) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const f = await db.query(
      `SELECT id, secret_b32 FROM av3_totp_factors
        WHERE user_id=$1 AND status='verified' ORDER BY verified_at DESC LIMIT 1`, [uid],
    );
    if (f.rowCount === 0) return reply.code(404).send({ error: "no_verified_factor" });
    const ok = verifyTotp(base32Decode(f.rows[0].secret_b32), body.data.code);
    if (!ok) return reply.code(400).send({ error: "invalid_code" });
    await db.query(`UPDATE av3_totp_factors SET last_used_at=now() WHERE id=$1`, [f.rows[0].id]);
    return { step_up_ok: true };
  });

  app.delete("/auth/v3/totp/:id", async (req, reply) => {
    const uid = requireUser(req);
    const { id } = req.params as { id: string };
    const r = await db.query(
      `UPDATE av3_totp_factors SET status='revoked' WHERE id=$1 AND user_id=$2`, [id, uid],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    await audit(req, { action: "totp.revoke", target_id: id });
    return { revoked: true };
  });

  app.post("/auth/v3/recovery-codes/generate", async (req) => {
    const uid = requireUser(req);
    const codes: string[] = [];
    for (let i = 0; i < 10; i++) codes.push(b64url(randomBytes(6)));
    await db.query(`DELETE FROM av3_recovery_codes WHERE user_id=$1`, [uid]);
    for (const c of codes) {
      await db.query(
        `INSERT INTO av3_recovery_codes (user_id, code_hash) VALUES ($1,$2)`,
        [uid, hashCode(c)],
      );
    }
    await audit(req, { action: "recovery.generate" });
    return { codes };
  });

  app.post("/auth/v3/recovery-codes/consume", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({ code: z.string().min(4) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const h = hashCode(body.data.code);
    const r = await db.query(
      `UPDATE av3_recovery_codes SET consumed_at=now()
         WHERE user_id=$1 AND code_hash=$2 AND consumed_at IS NULL
         RETURNING id`, [uid, h],
    );
    if (r.rowCount === 0) return reply.code(400).send({ error: "invalid_or_used" });
    await audit(req, { action: "recovery.consume" });
    return { consumed: true, step_up_ok: true };
  });

  // ------------------------------------------------------------------------
  // Session risk scoring + device management
  // ------------------------------------------------------------------------
  app.post("/auth/v3/sessions/score", async (req, reply) => {
    const uid = requireUser(req);
    const body = z.object({
      signals: z.object({
        known_device:         z.boolean().default(false),
        same_ip_asn:          z.boolean().default(false),
        new_country:          z.boolean().default(false),
        impossible_travel:    z.boolean().default(false),
        failed_attempts_15m:  z.number().int().min(0).default(0),
        tor_or_vpn:           z.boolean().default(false),
      }),
      device_hash: z.string().optional(),
      ip:          z.string().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    const score = scoreSession(body.data.signals as RiskSignals);

    // Record the session with score so admins can audit later.
    let device_id: string | null = null;
    if (body.data.device_hash) {
      const d = await db.query(
        `INSERT INTO av3_devices (user_id, device_hash, user_agent, ip_last)
         VALUES ($1,$2,$3,$4::inet)
         ON CONFLICT (user_id, device_hash) DO UPDATE
           SET last_seen_at=now(), ip_last=EXCLUDED.ip_last
         RETURNING id`,
        [uid, body.data.device_hash, req.headers["user-agent"] ?? null, body.data.ip ?? null],
      );
      device_id = d.rows[0].id;
    }
    await db.query(
      `INSERT INTO av3_sessions (user_id, device_id, ip, risk_score, step_up_ok)
       VALUES ($1,$2,$3::inet,$4,false)`,
      [uid, device_id, body.data.ip ?? null, score.score],
    );
    return score;
  });

  app.get("/auth/v3/devices", async (req) => {
    const uid = requireUser(req);
    const r = await db.query(
      `SELECT id, device_hash, label, user_agent, ip_last, trusted,
              first_seen_at, last_seen_at, revoked_at
         FROM av3_devices WHERE user_id=$1 ORDER BY last_seen_at DESC`, [uid],
    );
    return { items: r.rows };
  });

  app.patch("/auth/v3/devices/:id", async (req, reply) => {
    const uid = requireUser(req);
    const { id } = req.params as { id: string };
    const body = z.object({
      label:   z.string().max(80).nullable().optional(),
      trusted: z.boolean().optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const r = await db.query(
      `UPDATE av3_devices SET
         label   = COALESCE($3, label),
         trusted = COALESCE($4, trusted)
       WHERE id=$1 AND user_id=$2 RETURNING id, label, trusted`,
      [id, uid, body.data.label ?? null, body.data.trusted ?? null],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found" });
    return r.rows[0];
  });

  app.delete("/auth/v3/devices/:id", async (req, reply) => {
    const uid = requireUser(req);
    const { id } = req.params as { id: string };
    const r = await db.query(
      `UPDATE av3_devices SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [id, uid],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found_or_revoked" });
    // Revoke all sessions on that device too.
    await db.query(
      `UPDATE av3_sessions SET revoked_at=now() WHERE device_id=$1 AND revoked_at IS NULL`, [id],
    );
    await audit(req, { action: "device.revoke", target_id: id });
    return { revoked: true };
  });

  app.get("/auth/v3/sessions", async (req) => {
    const uid = requireUser(req);
    const r = await db.query(
      `SELECT id, device_id, ip, risk_score, step_up_ok, created_at, last_seen_at, revoked_at
         FROM av3_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 200`, [uid],
    );
    return { items: r.rows };
  });

  app.delete("/auth/v3/sessions/:id", async (req, reply) => {
    const uid = requireUser(req);
    const { id } = req.params as { id: string };
    const r = await db.query(
      `UPDATE av3_sessions SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,
      [id, uid],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: "not_found_or_revoked" });
    await audit(req, { action: "session.revoke", target_id: id });
    return { revoked: true };
  });

  app.log.info({ module: "auth_v3", phase: 50 }, "auth_v3 registered");
}

export { deviceHash };
export default authV3Plugin;
