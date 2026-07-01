import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";
import { storage, localDriver } from "../../lib/storage.js";
import { log } from "../../lib/logs.js";

const IDENT = /^[a-zA-Z0-9_-]+$/;

export async function storageRoutes(app: FastifyInstance) {
  // Public sig-verified download (local driver) — no apikey required.
  app.get("/object/public/:bucket/*", async (req, reply) => {
    const { bucket } = req.params as { bucket: string; "*": string };
    const key = (req.params as Record<string, string>)["*"];
    const b = await db.selectFrom("buckets").selectAll().where("name", "=", bucket).executeTakeFirst();
    if (!b || !b.public) return reply.code(404).send({ error: "not_found" });
    try {
      reply.header("cache-control", "public, max-age=3600");
      return reply.send(await storage.get(bucket, key));
    } catch { return reply.code(404).send({ error: "not_found" }); }
  });

  // All other storage endpoints require an api key.
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);

    scoped.get("/buckets", async () => db.selectFrom("buckets").selectAll().orderBy("created_at", "desc").execute());

    scoped.post("/buckets", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const body = z.object({ name: z.string().regex(IDENT).max(64), public: z.boolean().default(false) }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      await db.insertInto("buckets").values({ name: body.data.name, public: body.data.public, created_at: new Date() }).execute();
      return reply.code(201).send({ ok: true });
    });

    scoped.delete("/buckets/:name", async (req, reply) => {
      requireServiceRole(req, reply);
      if (reply.sent) return;
      const { name } = req.params as { name: string };
      await db.deleteFrom("buckets").where("name", "=", name).execute();
      return { ok: true };
    });

    scoped.post("/object/:bucket/*", async (req, reply) => {
      if (!req.auth?.user && req.auth?.apiKey !== "service_role") {
        return reply.code(401).send({ error: "unauthenticated" });
      }
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      const b = await db.selectFrom("buckets").selectAll().where("name", "=", bucket).executeTakeFirst();
      if (!b) return reply.code(404).send({ error: "bucket_not_found" });

      const file = await req.file();
      if (!file) return reply.code(400).send({ error: "no_file" });
      const buf = await file.toBuffer();
      const ct = file.mimetype ?? "application/octet-stream";
      await storage.put(bucket, key, buf, ct);
      await db.insertInto("objects")
        .values({
          id: crypto.randomUUID(), bucket, key, size: buf.length, content_type: ct,
          owner_id: req.auth.user?.sub ?? null, created_at: new Date(),
        })
        .onConflict((oc) => oc.columns(["bucket", "key"]).doUpdateSet({
          size: buf.length, content_type: ct, owner_id: req.auth?.user?.sub ?? null,
        }))
        .execute();
      await log("storage", "info", `put ${bucket}/${key}`, req.auth.user?.sub ?? null);
      return reply.code(201).send({ bucket, key, size: buf.length, content_type: ct });
    });

    scoped.get("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      const q = (req.query ?? {}) as { exp?: string; sig?: string; mode?: string };
      if (q.sig && q.exp && localDriver) {
        if (!localDriver.verifyLocalSig(bucket, key, Number(q.exp), q.sig, "read")) {
          return reply.code(403).send({ error: "bad_signature" });
        }
      }
      try { return reply.send(await storage.get(bucket, key)); }
      catch { return reply.code(404).send({ error: "not_found" }); }
    });

    scoped.delete("/object/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      const obj = await db.selectFrom("objects").selectAll()
        .where("bucket", "=", bucket).where("key", "=", key).executeTakeFirst();
      if (!obj) return reply.code(404).send({ error: "not_found" });
      if (req.auth?.apiKey !== "service_role" && obj.owner_id && obj.owner_id !== req.auth?.user?.sub) {
        return reply.code(403).send({ error: "forbidden" });
      }
      await storage.remove(bucket, key);
      await db.deleteFrom("objects").where("bucket", "=", bucket).where("key", "=", key).execute();
      return { ok: true };
    });

    scoped.post("/object/sign/:bucket/*", async (req, reply) => {
      const { bucket } = req.params as { bucket: string };
      const key = (req.params as Record<string, string>)["*"];
      const body = z.object({
        expires_in: z.number().int().min(1).max(60 * 60 * 24).default(900),
        mode: z.enum(["read", "write"]).default("read"),
      }).safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      const url = await storage.signedUrl(bucket, key, body.data.expires_in, body.data.mode);
      return { url, expires_in: body.data.expires_in };
    });

    scoped.get("/list/:bucket", async (req) => {
      const { bucket } = req.params as { bucket: string };
      const q = (req.query ?? {}) as { prefix?: string; limit?: string };
      let query = db.selectFrom("objects").selectAll().where("bucket", "=", bucket);
      if (q.prefix) query = query.where("key", "like", `${q.prefix}%`);
      return query.orderBy("created_at", "desc").limit(Math.min(1000, Number(q.limit ?? 100))).execute();
    });
  });
}
