import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";
import { storage, localDriver } from "../../lib/storage.js";
import { log } from "../../lib/logs.js";
import { checkStorageAccess, checkUploadCaps } from "../../lib/storage-access.js";
import { audit } from "../../lib/audit.js";

const IDENT = /^[a-zA-Z0-9_-]+$/;
// Object keys: forbid absolute paths, backrefs, and shell/HTML metas.
// `/` is allowed for pseudo-folders. Max 512 chars (S3-friendly).
const KEY_RX = /^(?!\/)(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9._\-\/]{1,512}$/;

export async function storageRoutes(app: FastifyInstance) {
  // ── Public, unauthenticated read for buckets marked `public` ──────
  // Uses the same signed-URL machinery for cacheability. RLS is
  // trivially "always allow read on public buckets".
  app.get("/object/public/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string; "*": string };
    const key = (req.params as Record<string, string>)["*"];
    if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });
    const b = await db.selectFrom("buckets").selectAll().where("name", "=", bucket).executeTakeFirst();
    if (!b || !b.public) return reply.code(404).send({ error: "not_found" });
    try {
      reply.header("cache-control", "public, max-age=3600");
      return reply.send(await storage.get(bucket, key));
    } catch { return reply.code(404).send({ error: "not_found" }); }
  });

  // ── Signed URL redirect endpoint ──────────────────────────────────
  // Local-driver signed URLs land here without an api key; we validate
  // the HMAC and stream directly.
  app.get("/object/signed/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string; "*": string };
    const key = (req.params as Record<string, string>)["*"];
    const q = (req.query ?? {}) as { exp?: string; sig?: string };
    if (!q.sig || !q.exp || !localDriver) return reply.code(400).send({ error: "missing_sig" });
    if (!localDriver.verifyLocalSig(bucket, key, Number(q.exp), q.sig, "read")) {
      return reply.code(403).send({ error: "bad_signature" });
    }
    try { return reply.send(await storage.get(bucket, key)); }
    catch { return reply.code(404).send({ error: "not_found" }); }
  });

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);

    // Buckets — service_role only for create/delete/patch.
    scoped.get("/buckets", async () =>
      db.selectFrom("buckets").selectAll().orderBy("created_at", "desc").execute());

    scoped.post("/buckets", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const body = z.object({
        name: z.string().regex(IDENT).max(64),
        public: z.boolean().default(false),
        owner_only: z.boolean().default(true),
        max_size: z.number().int().min(1).max(5 * 1024 * 1024 * 1024).default(26214400),
        allowed_mime: z.array(z.string().max(255)).max(64).optional(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      await db.insertInto("buckets" as never).values({
        name: body.data.name, public: body.data.public,
        owner_only: body.data.owner_only, max_size: body.data.max_size,
        allowed_mime: body.data.allowed_mime ?? null, created_at: new Date(),
      } as never).execute();
      await audit(req, { action: "storage.bucket.create", target: body.data.name, status: "ok" });
      return reply.code(201).send({ ok: true });
    });

    scoped.delete("/buckets/:name", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const { name } = req.params as { name: string };
      await db.deleteFrom("buckets").where("name", "=", name).execute();
      await audit(req, { action: "storage.bucket.delete", target: name, status: "ok" });
      return { ok: true };
    });

    // ── Bucket policies (service_role only) ────────────────────────
    scoped.get("/buckets/:name/policies", async (req) => {
      const { name } = req.params as { name: string };
      return db.selectFrom("bucket_policies" as never).selectAll()
        .where("bucket" as never, "=", name as never).execute();
    });

    scoped.put("/buckets/:name/policies", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const { name } = req.params as { name: string };
      const body = z.object({
        role:   z.enum(["anon", "authenticated", "owner"]),
        action: z.enum(["read", "write", "delete", "sign_read", "sign_write"]),
        allow:  z.boolean(),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      await db.insertInto("bucket_policies" as never)
        .values({ bucket: name, ...body.data } as never)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onConflict((oc: any) =>
          oc.columns(["bucket", "role", "action"]).doUpdateSet({ allow: body.data.allow }))
        .execute();
      await audit(req, { action: "storage.policy.upsert", target: `${name}:${body.data.role}:${body.data.action}`, status: "ok", metadata: { allow: body.data.allow } });
      return { ok: true };
    });

    // ── Upload ─────────────────────────────────────────────────────
    scoped.post("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });

      const existing = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();

      const decision = await checkStorageAccess(req, {
        bucket, key, action: "write", ownerId: existing?.owner_id ?? null,
      });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "no_file" });
      const buf = await file.toBuffer();
      const ct = file.mimetype ?? "application/octet-stream";

      const caps = await checkUploadCaps(bucket, buf.length, ct);
      if (!caps.ok) return reply.code(caps.status).send({ error: caps.error });

      await storage.put(bucket, key, buf, ct);
      await db.insertInto("objects")
        .values({
          id: crypto.randomUUID(), bucket, key, size: buf.length, content_type: ct,
          owner_id: existing?.owner_id ?? req.auth?.user?.sub ?? null, created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(["bucket", "key"]).doUpdateSet({
          size: buf.length, content_type: ct,
        }))
        .execute();
      await log("storage", "info", `put ${bucket}/${key}`, req.auth?.user?.sub ?? null);
      await audit(req, { action: "storage.object.put", target: `${bucket}/${key}`, status: "ok", metadata: { size: buf.length, content_type: ct } });
      return reply.code(201).send({ bucket, key, size: buf.length, content_type: ct });
    });

    // ── Download ───────────────────────────────────────────────────
    scoped.get("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });

      const obj = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      if (!obj) return reply.code(404).send({ error: "not_found" });

      const decision = await checkStorageAccess(req, { bucket, key, action: "read", ownerId: obj.owner_id });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });

      reply.header("content-type", obj.content_type);
      reply.header("content-length", String(obj.size));
      try { return reply.send(await storage.get(bucket, key)); }
      catch { return reply.code(404).send({ error: "not_found" }); }
    });

    // ── HEAD (metadata only) ───────────────────────────────────────
    scoped.head("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send();
      const obj = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      if (!obj) return reply.code(404).send();
      const decision = await checkStorageAccess(req, { bucket, key, action: "read", ownerId: obj.owner_id });
      if (!decision.ok) return reply.code(decision.status).send();
      reply.header("content-type", obj.content_type);
      reply.header("content-length", String(obj.size));
      reply.header("x-owner-id", obj.owner_id ?? "");
      reply.header("last-modified", new Date(obj.created_at).toUTCString());
      return reply.code(200).send();
    });

    // ── Delete ─────────────────────────────────────────────────────
    scoped.delete("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });
      const obj = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      if (!obj) return reply.code(404).send({ error: "not_found" });
      const decision = await checkStorageAccess(req, { bucket, key, action: "delete", ownerId: obj.owner_id });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });
      await storage.remove(bucket, key);
      await db.deleteFrom("objects").where("bucket", "=", bucket).where("key", "=", key).execute();
      await audit(req, { action: "storage.object.delete", target: `${bucket}/${key}`, status: "ok" });
      return { ok: true };
    });

    // ── Signed URL mint ────────────────────────────────────────────
    scoped.post("/object/sign/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });
      const body = z.object({
        expires_in: z.number().int().min(1).max(60 * 60 * 24).default(900),
        mode: z.enum(["read", "write"]).default("read"),
      }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const existing = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      // For sign_write on a fresh key, treat owner as the caller (they'd own it after upload).
      const action = body.data.mode === "read" ? "sign_read" : "sign_write";
      const decision = await checkStorageAccess(req, { bucket, key, action, ownerId: existing?.owner_id ?? null });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });

      const url = await storage.signedUrl(bucket, key, body.data.expires_in, body.data.mode);
      await audit(req, { action: `storage.sign.${body.data.mode}`, target: `${bucket}/${key}`, status: "ok", metadata: { expires_in: body.data.expires_in } });
      return { url, expires_in: body.data.expires_in };
    });

    // ── List — filtered to caller's visibility ─────────────────────
    scoped.get("/list/:bucket", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const q = (req.query ?? {}) as { prefix?: string; limit?: string };
      // Anyone with any read grant on the bucket may list metadata.
      const preflight = await checkStorageAccess(req, { bucket, key: "*", action: "read", ownerId: null });
      // For owner_only buckets, `preflight` may return 403 because ownerId=null; fall through
      // and let the query filter by owner instead. Only hard-fail on 404.
      if (!preflight.ok && preflight.status === 404) return reply.code(404).send({ error: preflight.error });

      let query = db.selectFrom("objects").selectAll().where("bucket", "=", bucket);
      if (q.prefix) query = query.where("key", "like", `${q.prefix}%`);
      // owner_only buckets: non-service callers only see their own rows.
      if (req.auth?.apiKey !== "service_role" && req.auth?.user?.sub) {
        const b = await db.selectFrom("buckets" as never).select(["owner_only" as never])
          .where("name" as never, "=", bucket as never).executeTakeFirst() as { owner_only: boolean } | undefined;
        if (b?.owner_only) query = query.where("owner_id", "=", req.auth.user.sub);
      }
      return query.orderBy("created_at", "desc").limit(Math.min(1000, Number(q.limit ?? 100))).execute();
    });
  });
}
