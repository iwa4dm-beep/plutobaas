import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import argon2 from "argon2";
import { z } from "zod";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { signAccessToken, verifyAccessToken } from "../../lib/jwt.js";
import { requireApiKey } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";

const credsSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(200),
});

function hashToken(t: string): string {
  return createHash("sha256").update(t).digest("hex");
}

async function issueSession(user: { id: string; email: string; role: "admin" | "user" }) {
  const access_token = await signAccessToken({ sub: user.id, role: user.role, email: user.email });
  const refresh_token = randomBytes(32).toString("hex");
  const expires_at = new Date(Date.now() + env.REFRESH_TOKEN_TTL_SEC * 1000);
  await db.insertInto("refresh_tokens").values({
    id: crypto.randomUUID(),
    user_id: user.id,
    token_hash: hashToken(refresh_token),
    expires_at,
    revoked_at: null,
  }).execute();
  return {
    access_token,
    refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + env.ACCESS_TOKEN_TTL_SEC,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);

  app.post("/sign-up", async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body", details: parsed.error.flatten() });
    const { email, password } = parsed.data;

    const existing = await db.selectFrom("users").select("id").where("email", "=", email).executeTakeFirst();
    if (existing) return reply.code(409).send({ error: "email_taken" });

    const password_hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2 });
    const userCountRow = await db.selectFrom("users").select(db.fn.count<string>("id").as("c")).executeTakeFirst();
    const isFirst = !userCountRow || Number(userCountRow.c) === 0;

    const id = crypto.randomUUID();
    const user = { id, email, role: (isFirst ? "admin" : "user") as "admin" | "user" };
    await db.insertInto("users").values({
      id,
      email,
      password_hash,
      role: user.role,
      email_verified: false,
      created_at: new Date(),
    }).execute();

    const session = await issueSession(user);
    await log("auth", "info", `sign-up ${email}`, id);
    return { user: { ...user, email_verified: false }, session };
  });

  app.post("/sign-in", async (req, reply) => {
    const parsed = credsSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
    const { email, password } = parsed.data;

    const row = await db.selectFrom("users").selectAll().where("email", "=", email).executeTakeFirst();
    if (!row) return reply.code(401).send({ error: "invalid_credentials" });
    const ok = await argon2.verify(row.password_hash, password);
    if (!ok) {
      await log("auth", "warn", `failed sign-in ${email}`);
      return reply.code(401).send({ error: "invalid_credentials" });
    }
    const session = await issueSession({ id: row.id, email: row.email, role: row.role });
    await log("auth", "info", `sign-in ${email}`, row.id);
    return {
      user: { id: row.id, email: row.email, role: row.role, email_verified: row.email_verified },
      session,
    };
  });

  app.post("/refresh", async (req, reply) => {
    const body = z.object({ refresh_token: z.string() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    const hashed = hashToken(body.data.refresh_token);
    const row = await db.selectFrom("refresh_tokens")
      .selectAll()
      .where("token_hash", "=", hashed)
      .executeTakeFirst();
    if (!row || row.revoked_at || row.expires_at < new Date()) {
      return reply.code(401).send({ error: "invalid_refresh_token" });
    }
    const user = await db.selectFrom("users").selectAll().where("id", "=", row.user_id).executeTakeFirst();
    if (!user) return reply.code(401).send({ error: "invalid_refresh_token" });

    // rotate
    await db.updateTable("refresh_tokens").set({ revoked_at: new Date() }).where("id", "=", row.id).execute();
    const session = await issueSession({ id: user.id, email: user.email, role: user.role });
    return { session };
  });

  app.post("/sign-out", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    await db.updateTable("refresh_tokens")
      .set({ revoked_at: new Date() })
      .where("user_id", "=", req.auth.user.sub)
      .where("revoked_at", "is", null)
      .execute();
    return { ok: true };
  });

  app.get("/user", async (req, reply) => {
    if (!req.auth?.user) return reply.code(401).send({ error: "unauthenticated" });
    const row = await db.selectFrom("users")
      .select(["id", "email", "role", "email_verified", "created_at"])
      .where("id", "=", req.auth.user.sub)
      .executeTakeFirst();
    if (!row) return reply.code(404).send({ error: "not_found" });
    return { user: row };
  });
}
