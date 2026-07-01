// /admin/v1/migrations — inspect ledger, run pending, re-run one,
// rollback one. Requires service-role API key (admin scope only).

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";
import { listMigrations, runPending, rerunOne, rollback } from "../../lib/migrator.js";
import { log } from "../../lib/logs.js";

export async function migrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  app.addHook("preHandler", async (req, reply) => { requireServiceRole(req, reply); });

  app.get("/", async () => ({ migrations: await listMigrations() }));

  app.post("/run", async (req) => {
    const actor = req.auth?.user?.sub ?? "service_role";
    const result = await runPending(actor);
    await log("admin", "info", `migrations run: +${result.applied.length}, ${result.failed.length} failed`, req.auth?.user?.sub ?? null);
    return result;
  });

  app.post("/:version/rerun", async (req, reply) => {
    const p = z.object({ version: z.string().regex(/^[\w.-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_version" });
    try {
      const row = await rerunOne(p.data.version, req.auth?.user?.sub ?? "service_role");
      await log("admin", "warn", `migration rerun ${p.data.version}`, req.auth?.user?.sub ?? null);
      return { ok: true, row };
    } catch (e) {
      return reply.code(400).send({ error: "rerun_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/:version/rollback", async (req, reply) => {
    const p = z.object({ version: z.string().regex(/^[\w.-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_version" });
    try {
      const result = await rollback(p.data.version, req.auth?.user?.sub ?? "service_role");
      await log("admin", "warn", `migration rollback ${p.data.version}`, req.auth?.user?.sub ?? null);
      return result;
    } catch (e) {
      return reply.code(400).send({ error: "rollback_failed", message: e instanceof Error ? e.message : String(e) });
    }
  });
}
