import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../db/index.js";
import { env } from "../../config.js";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";
import { storage, localDriver } from "../../lib/storage.js";
import { log } from "../../lib/logs.js";
import { checkStorageAccess, checkUploadCaps } from "../../lib/storage-access.js";
import { audit } from "../../lib/audit.js";

const IDENT = /^[a-zA-Z0-9_-]+$/;
// Object keys: forbid absolute paths, backrefs, and shell/HTML metas.
const KEY_RX = /^(?!\/)(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9._\-\/]{1,512}$/;
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Multipart staging root (local driver only). Uploaded parts land here
// until `complete` promotes them into the real storage backend.
const STAGING = resolve(env.STORAGE_LOCAL_DIR, ".uploads");
const MIN_PART = 64 * 1024;                 // 64 KiB
const MAX_PART = 32 * 1024 * 1024;          // 32 MiB
const MAX_PARTS = 10_000;

async function ensureDir(p: string) { await mkdir(p, { recursive: true }); }

export async function storageRoutes(app: FastifyInstance) {
  // ── Public read for buckets marked `public` ───────────────────────
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

  // ── Signed URL redirect (local driver) ────────────────────────────
  //
  // Strict verification, in order:
  //  1. HMAC over (mode|bucket|key|exp|tok) with the JWT secret
  //  2. Query-string `exp` not in the past
  //  3. Persistent grant row exists, matches all fields, unrevoked,
  //     unused-if-one_time, and its own `expires_at` is fresh
  //  4. If one_time: atomically stamp used_at
  app.get("/object/signed/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string; "*": string };
    const key = (req.params as Record<string, string>)["*"];
    const q = (req.query ?? {}) as { exp?: string; sig?: string; tok?: string; mode?: string };
    if (!q.sig || !q.exp || !localDriver) return reply.code(400).send({ error: "missing_sig" });
    const mode = (q.mode === "write" ? "write" : "read");
    if (!localDriver.verifyLocalSig(bucket, key, Number(q.exp), q.sig, mode, q.tok ?? "")) {
      return reply.code(403).send({ error: "bad_signature" });
    }

    // Grant lookup — required for revocation & one-time enforcement.
    if (!q.tok || !UUID_RX.test(q.tok)) return reply.code(403).send({ error: "missing_grant" });
    const grant = await db.selectFrom("storage_signed_grants" as never).selectAll()
      .where("id" as never, "=", q.tok as never).executeTakeFirst() as
        | { id: string; bucket: string; key: string; mode: string; one_time: boolean;
            expires_at: Date; used_at: Date | null; revoked_at: Date | null }
        | undefined;
    if (!grant) return reply.code(403).send({ error: "unknown_grant" });
    if (grant.bucket !== bucket || grant.key !== key || grant.mode !== mode)
      return reply.code(403).send({ error: "grant_mismatch" });
    if (grant.revoked_at) return reply.code(403).send({ error: "grant_revoked" });
    if (new Date(grant.expires_at).getTime() < Date.now())
      return reply.code(403).send({ error: "grant_expired" });
    if (grant.used_at && grant.one_time)
      return reply.code(403).send({ error: "grant_already_used" });

    if (grant.one_time) {
      // Atomic: only the first winner gets a rowcount == 1.
      const upd = await db.updateTable("storage_signed_grants" as never)
        .set({ used_at: new Date(), used_ip: req.ip } as never)
        .where("id" as never, "=", q.tok as never)
        .where("used_at" as never, "is", null as never)
        .executeTakeFirst();
      if (Number(upd.numUpdatedRows ?? 0) === 0) return reply.code(403).send({ error: "grant_already_used" });
    }

    try {
      await audit(req, {
        action: `storage.signed.${mode}.consume`,
        target: `${bucket}/${key}`, status: "ok",
        metadata: { grant_id: grant.id, one_time: grant.one_time },
      });
      return reply.send(await storage.get(bucket, key));
    } catch { return reply.code(404).send({ error: "not_found" }); }
  });

  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);

    // ── Buckets ────────────────────────────────────────────────────
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

    // ── Bucket policies ────────────────────────────────────────────
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

    // ── Upload (single-shot ≤ max_size) ────────────────────────────
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
          id: randomUUID(), bucket, key, size: buf.length, content_type: ct,
          owner_id: existing?.owner_id ?? req.auth?.user?.sub ?? null, created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(["bucket", "key"]).doUpdateSet({ size: buf.length, content_type: ct }))
        .execute();
      await log("storage", "info", `put ${bucket}/${key}`, req.auth?.user?.sub ?? null);
      await audit(req, {
        action: "storage.object.put",
        target: `${bucket}/${key}`, status: "ok",
        metadata: { size: buf.length, content_type: ct, mode: "single" },
      });
      const { recordUsage } = await import("../../lib/metering.js");
      void recordUsage({ workspaceId: req.auth?.workspaceId ?? null, metric: "storage_gb",
        quantity: buf.length / 1_073_741_824, billingLabel: `storage:${bucket}`,
        meta: { bucket, key, bytes: buf.length } });
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
      const { recordUsage } = await import("../../lib/metering.js");
      void recordUsage({ workspaceId: req.auth?.workspaceId ?? null, metric: "egress_gb",
        quantity: (obj.size ?? 0) / 1_073_741_824, billingLabel: `egress:${bucket}`,
        meta: { bucket, key, bytes: obj.size } });
      try { return reply.send(await storage.get(bucket, key)); }
      catch { return reply.code(404).send({ error: "not_found" }); }
    });

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

    // ── Sign URL mint (persistent, revocable, optionally one-time) ──
    scoped.post("/object/sign/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      if (!IDENT.test(bucket) || !KEY_RX.test(key)) return reply.code(400).send({ error: "invalid_key" });
      const body = z.object({
        expires_in: z.number().int().min(1).max(60 * 60 * 24).default(900),
        mode: z.enum(["read", "write"]).default("read"),
        one_time: z.boolean().default(false),
      }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const existing = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      const action = body.data.mode === "read" ? "sign_read" : "sign_write";
      const decision = await checkStorageAccess(req, {
        bucket, key, action, ownerId: existing?.owner_id ?? null,
      });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });

      const id = randomUUID();
      const expiresAt = new Date(Date.now() + body.data.expires_in * 1000);
      await db.insertInto("storage_signed_grants" as never).values({
        id, bucket, key, mode: body.data.mode, one_time: body.data.one_time,
        expires_at: expiresAt, issued_by: req.auth?.user?.sub ?? null,
        workspace_id: req.auth?.workspaceId ?? null, created_at: new Date(),
      } as never).execute();

      const url = await storage.signedUrl(bucket, key, body.data.expires_in, body.data.mode, id);
      await audit(req, {
        action: `storage.sign.${body.data.mode}`, target: `${bucket}/${key}`, status: "ok",
        metadata: { grant_id: id, expires_in: body.data.expires_in, one_time: body.data.one_time },
      });
      return { url, id, expires_at: expiresAt.toISOString(), one_time: body.data.one_time };
    });

    // List / revoke signed-URL grants (admin visibility for audits).
    scoped.get("/object/sign/grants", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const q = (req.query ?? {}) as { bucket?: string; active?: string };
      let query = db.selectFrom("storage_signed_grants" as never).selectAll();
      if (q.bucket) query = query.where("bucket" as never, "=", q.bucket as never);
      if (q.active === "true") {
        query = query.where("revoked_at" as never, "is", null as never)
                     .where("expires_at" as never, ">", new Date() as never);
      }
      return query.orderBy("created_at" as never, "desc").limit(200).execute();
    });

    scoped.delete("/object/sign/grants/:id", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const { id } = req.params as { id: string };
      if (!UUID_RX.test(id)) return reply.code(400).send({ error: "bad_id" });
      const upd = await db.updateTable("storage_signed_grants" as never)
        .set({ revoked_at: new Date(), revoked_by: req.auth?.user?.sub ?? null } as never)
        .where("id" as never, "=", id as never)
        .where("revoked_at" as never, "is", null as never)
        .executeTakeFirst();
      if (Number(upd.numUpdatedRows ?? 0) === 0) return reply.code(404).send({ error: "not_found_or_already_revoked" });
      await audit(req, { action: "storage.sign.revoke", target: id, status: "ok" });
      return { ok: true };
    });

    // ── List ───────────────────────────────────────────────────────
    scoped.get("/list/:bucket", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const q = (req.query ?? {}) as { prefix?: string; limit?: string };
      const preflight = await checkStorageAccess(req, { bucket, key: "*", action: "read", ownerId: null });
      if (!preflight.ok && preflight.status === 404) return reply.code(404).send({ error: preflight.error });

      let query = db.selectFrom("objects").selectAll().where("bucket", "=", bucket);
      if (q.prefix) query = query.where("key", "like", `${q.prefix}%`);
      if (req.auth?.apiKey !== "service_role" && req.auth?.user?.sub) {
        const b = await db.selectFrom("buckets" as never).select(["owner_only" as never])
          .where("name" as never, "=", bucket as never).executeTakeFirst() as { owner_only: boolean } | undefined;
        if (b?.owner_only) query = query.where("owner_id", "=", req.auth.user.sub);
      }
      return query.orderBy("created_at", "desc").limit(Math.min(1000, Number(q.limit ?? 100))).execute();
    });

    // ══════════════════════════════════════════════════════════════
    //   MULTIPART / RESUMABLE UPLOADS (local staging → single put)
    // ══════════════════════════════════════════════════════════════
    //
    // Flow:
    //   POST /upload/init                { bucket, key, size, content_type, part_size? }
    //     → { upload_id, part_size, expires_at }
    //   PUT  /upload/:id/part/:n  (raw body)
    //     → { part_number, size, etag }
    //   POST /upload/:id/complete       { parts: [{part_number, etag}] }
    //     → { bucket, key, size, content_type }
    //   DEL  /upload/:id/abort
    //
    // RLS write access is re-checked on EVERY request so revoked
    // permissions kill in-flight sessions immediately.

    async function loadUpload(id: string) {
      if (!UUID_RX.test(id)) return null;
      return await db.selectFrom("storage_uploads" as never).selectAll()
        .where("id" as never, "=", id as never).executeTakeFirst() as
          | { id: string; bucket: string; key: string; size: number; part_size: number;
              content_type: string; owner_id: string | null; workspace_id: string | null;
              status: string; created_at: Date }
          | undefined;
    }

    scoped.post("/upload/init", async (req, reply) => {
      const body = z.object({
        bucket: z.string().regex(IDENT).max(64),
        key: z.string().regex(KEY_RX),
        size: z.number().int().min(1).max(5 * 1024 * 1024 * 1024),
        content_type: z.string().max(255).default("application/octet-stream"),
        part_size: z.number().int().min(MIN_PART).max(MAX_PART).default(5 * 1024 * 1024),
      }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });
      const { bucket, key, size, content_type, part_size } = body.data;

      const partCount = Math.ceil(size / part_size);
      if (partCount > MAX_PARTS) return reply.code(400).send({ error: "too_many_parts" });

      const caps = await checkUploadCaps(bucket, size, content_type);
      if (!caps.ok) return reply.code(caps.status).send({ error: caps.error });

      const existing = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      const decision = await checkStorageAccess(req, { bucket, key, action: "write", ownerId: existing?.owner_id ?? null });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });

      const id = randomUUID();
      await db.insertInto("storage_uploads" as never).values({
        id, bucket, key, size, part_size, content_type,
        owner_id: req.auth?.user?.sub ?? null,
        workspace_id: req.auth?.workspaceId ?? null,
        status: "in_progress", created_at: new Date(),
      } as never).execute();

      await ensureDir(join(STAGING, id));
      await audit(req, {
        action: "storage.upload.init", target: `${bucket}/${key}`, status: "ok",
        metadata: { upload_id: id, size, part_size, parts: partCount },
      });
      return reply.code(201).send({
        upload_id: id, part_size,
        part_count: partCount,
        expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
      });
    });

    scoped.put("/upload/:id/part/:n", async (req, reply) => {
      const { id, n } = req.params as { id: string; n: string };
      const partNumber = Number(n);
      if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > MAX_PARTS)
        return reply.code(400).send({ error: "bad_part_number" });

      const up = await loadUpload(id);
      if (!up) return reply.code(404).send({ error: "unknown_upload" });
      if (up.status !== "in_progress") return reply.code(409).send({ error: `upload_${up.status}` });

      // Re-check RLS on every part.
      const decision = await checkStorageAccess(req, { bucket: up.bucket, key: up.key, action: "write", ownerId: up.owner_id });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });
      if (up.owner_id && req.auth?.apiKey !== "service_role" && req.auth?.user?.sub !== up.owner_id)
        return reply.code(403).send({ error: "not_upload_owner" });

      const partPath = join(STAGING, up.id, String(partNumber));
      await ensureDir(join(STAGING, up.id));
      // Stream request body to disk to avoid buffering huge parts in memory.
      const bodyStream = req.raw as unknown as Readable;
      await pipeline(bodyStream, createWriteStream(partPath));
      const st = await stat(partPath);
      if (st.size === 0) return reply.code(400).send({ error: "empty_part" });
      if (st.size > MAX_PART) { await rm(partPath, { force: true }); return reply.code(413).send({ error: "part_too_large" }); }

      // Reject over-run: sum-so-far must not exceed declared size.
      const priorRows = await db.selectFrom("storage_upload_parts" as never)
        .select(sql<string>`coalesce(sum(size),0)::text`.as("s"))
        .where("upload_id" as never, "=", up.id as never).executeTakeFirst() as { s: string } | undefined;
      const priorTotal = Number(priorRows?.s ?? 0);
      if (priorTotal + st.size > up.size) {
        await rm(partPath, { force: true });
        return reply.code(400).send({ error: "size_exceeded" });
      }

      const buf = await readFile(partPath);
      const etag = createHash("sha256").update(buf).digest("hex");
      await db.insertInto("storage_upload_parts" as never).values({
        upload_id: up.id, part_number: partNumber, size: st.size, etag, uploaded_at: new Date(),
      } as never)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .onConflict((oc: any) =>
          oc.columns(["upload_id", "part_number"]).doUpdateSet({ size: st.size, etag, uploaded_at: new Date() }))
        .execute();

      return { part_number: partNumber, size: st.size, etag };
    });

    scoped.post("/upload/:id/complete", async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = z.object({
        parts: z.array(z.object({ part_number: z.number().int().min(1), etag: z.string().min(1) })).min(1).max(MAX_PARTS),
      }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });

      const up = await loadUpload(id);
      if (!up) return reply.code(404).send({ error: "unknown_upload" });
      if (up.status !== "in_progress") return reply.code(409).send({ error: `upload_${up.status}` });

      const decision = await checkStorageAccess(req, { bucket: up.bucket, key: up.key, action: "write", ownerId: up.owner_id });
      if (!decision.ok) return reply.code(decision.status).send({ error: decision.error });
      if (up.owner_id && req.auth?.apiKey !== "service_role" && req.auth?.user?.sub !== up.owner_id)
        return reply.code(403).send({ error: "not_upload_owner" });

      // Verify parts match what's stored.
      const stored = await db.selectFrom("storage_upload_parts" as never).selectAll()
        .where("upload_id" as never, "=", up.id as never)
        .orderBy("part_number" as never, "asc")
        .execute() as { part_number: number; etag: string; size: number }[];
      const byNum = new Map(stored.map(p => [p.part_number, p]));
      let total = 0;
      const ordered = body.data.parts.slice().sort((a, b) => a.part_number - b.part_number);
      for (let i = 0; i < ordered.length; i++) {
        const p = ordered[i];
        if (p.part_number !== i + 1) return reply.code(400).send({ error: "missing_part", part: i + 1 });
        const s = byNum.get(p.part_number);
        if (!s) return reply.code(400).send({ error: "part_not_uploaded", part: p.part_number });
        if (s.etag !== p.etag) return reply.code(400).send({ error: "etag_mismatch", part: p.part_number });
        total += s.size;
      }
      if (total !== up.size)
        return reply.code(400).send({ error: "size_mismatch", declared: up.size, actual: total });

      // Concatenate parts into one buffer (fine for ≤5GB single-VPS use;
      // S3 backends should use real MPU — future enhancement).
      const chunks: Buffer[] = [];
      for (let i = 1; i <= ordered.length; i++) {
        chunks.push(await readFile(join(STAGING, up.id, String(i))));
      }
      const full = Buffer.concat(chunks);
      await storage.put(up.bucket, up.key, full, up.content_type);

      await db.insertInto("objects").values({
        id: randomUUID(), bucket: up.bucket, key: up.key,
        size: full.length, content_type: up.content_type,
        owner_id: up.owner_id, created_at: new Date(),
      })
        .onConflict((oc) => oc.columns(["bucket", "key"]).doUpdateSet({
          size: full.length, content_type: up.content_type,
        }))
        .execute();

      await db.updateTable("storage_uploads" as never)
        .set({ status: "completed", completed_at: new Date() } as never)
        .where("id" as never, "=", up.id as never).execute();
      await rm(join(STAGING, up.id), { recursive: true, force: true });

      await audit(req, {
        action: "storage.upload.complete", target: `${up.bucket}/${up.key}`, status: "ok",
        metadata: { upload_id: up.id, size: full.length, parts: ordered.length, mode: "multipart" },
      });
      return { bucket: up.bucket, key: up.key, size: full.length, content_type: up.content_type };
    });

    scoped.delete("/upload/:id/abort", async (req, reply) => {
      const { id } = req.params as { id: string };
      const up = await loadUpload(id);
      if (!up) return reply.code(404).send({ error: "unknown_upload" });
      if (up.owner_id && req.auth?.apiKey !== "service_role" && req.auth?.user?.sub !== up.owner_id)
        return reply.code(403).send({ error: "not_upload_owner" });
      await db.updateTable("storage_uploads" as never)
        .set({ status: "aborted", aborted_at: new Date() } as never)
        .where("id" as never, "=", up.id as never).execute();
      await rm(join(STAGING, up.id), { recursive: true, force: true });
      await audit(req, { action: "storage.upload.abort", target: `${up.bucket}/${up.key}`, status: "ok", metadata: { upload_id: up.id } });
      return { ok: true };
    });

    scoped.get("/upload/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const up = await loadUpload(id);
      if (!up) return reply.code(404).send({ error: "unknown_upload" });
      if (up.owner_id && req.auth?.apiKey !== "service_role" && req.auth?.user?.sub !== up.owner_id)
        return reply.code(403).send({ error: "not_upload_owner" });
      const parts = await db.selectFrom("storage_upload_parts" as never)
        .select(["part_number", "size", "etag"] as never)
        .where("upload_id" as never, "=", up.id as never)
        .orderBy("part_number" as never, "asc").execute();
      return { upload: up, parts };
    });
  });

  // Suppress unused-import warning in --isolatedModules builds.
  void writeFile;
  void createReadStream;
}
