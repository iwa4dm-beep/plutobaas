// Phase 63 — CORS admin endpoints.
// Endpoints (require service-role key):
//   GET    /admin/v1/cors/origins
//   POST   /admin/v1/cors/origins            { origin, workspace_id?, note? }
//   DELETE /admin/v1/cors/origins/:id
//
// Mutations invalidate the in-memory cache so changes apply immediately.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { invalidateOriginCache } from "./registry.js";

const originSchema = z
  .string()
  .min(4)
  .max(255)
  .regex(/^https?:\/\/[^\s/]+(:\d+)?$/i, "must be a bare origin like https://app.example.com");

export async function corsAdminPlugin(app: FastifyInstance) {
  app.get("/admin/v1/cors/origins", async () => {
    const rows = await db
      .selectFrom("allowed_origins" as never)
      .select(["id", "workspace_id", "origin", "note", "created_at"] as never)
      .orderBy("created_at" as never, "desc")
      .execute();
    return { items: rows };
  });

  app.post("/admin/v1/cors/origins", async (req, reply) => {
    const b = z
      .object({
        origin: originSchema,
        workspace_id: z.string().uuid().nullable().optional(),
        note: z.string().max(500).optional(),
      })
      .safeParse(req.body);
    if (!b.success) {
      reply.code(400);
      return { error: "bad_request", issues: b.error.issues };
    }
    try {
      const row = await db
        .insertInto("allowed_origins" as never)
        .values({
          origin: b.data.origin.toLowerCase(),
          workspace_id: b.data.workspace_id ?? null,
          note: b.data.note ?? null,
        } as never)
        .returning(["id", "workspace_id", "origin", "note", "created_at"] as never)
        .executeTakeFirstOrThrow();
      invalidateOriginCache();
      return { item: row };
    } catch (e) {
      reply.code(409);
      return { error: "duplicate_or_invalid", detail: (e as Error).message };
    }
  });

  app.delete("/admin/v1/cors/origins/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) {
      reply.code(400);
      return { error: "bad_id" };
    }
    await db
      .deleteFrom("allowed_origins" as never)
      .where("id" as never, "=", id)
      .execute();
    invalidateOriginCache();
    return { ok: true };
  });
}
