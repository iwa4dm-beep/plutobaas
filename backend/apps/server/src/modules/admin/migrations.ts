// /admin/v1/migrations — inspect ledger, dry-run, run pending,
// re-run one, rollback one. Requires an active admin session AND the
// service-role api key (see requireAdmin).
//
// All mutating actions:
//   * are recorded in `public.audit_events`
//   * emit realtime progress on the `system:migrations` broadcast
//     channel so the dashboard can stream live status

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireApiKey, requireAdmin } from "../../lib/apikey.js";
import {
  listMigrations, planPending, planPendingDetailed, runPending, rerunOne, rollback,
} from "../../lib/migrator.js";
import { audit, emit } from "../../lib/audit.js";

const CHANNEL = "system:migrations";
const emitter = (req: FastifyRequest) =>
  async (event: string, payload: unknown) => {
    await emit(CHANNEL, event, { ...(payload as object), actor: req.auth?.user?.email ?? null });
  };

export async function migrationRoutes(app: FastifyInstance) {
  app.addHook("preHandler", requireApiKey);
  app.addHook("preHandler", async (req, reply) => { requireAdmin(req, reply); });

  app.get("/", async () => ({ migrations: await listMigrations() }));

  app.post("/run", async (req) => {
    const body = z.object({
      dry_run: z.boolean().default(false),
      detailed: z.boolean().default(true),
    }).safeParse(req.body ?? {});
    const dryRun = body.success ? body.data.dry_run : false;
    const detailed = body.success ? body.data.detailed : true;
    const actor = req.auth?.user?.sub ?? "service_role";

    if (dryRun) {
      // Detailed plan runs each migration in a transaction that ALWAYS
      // rolls back. Zero DB writes, but we still record the dry-run in
      // the audit trail so admins have a receipt.
      const plan = detailed ? await planPendingDetailed() : await planPending();
      await audit(req, {
        action: "migration.run",
        status: "dry_run",
        metadata: {
          versions: plan.map((p) => p.version),
          count: plan.length,
          detailed,
          totals: {
            added:   plan.reduce((n, p) => n + p.diff.added.length, 0),
            removed: plan.reduce((n, p) => n + p.diff.removed.length, 0),
            changed: plan.reduce((n, p) => n + p.diff.changed.length, 0),
          },
        },
      });
      return { dry_run: true, plan };
    }

    const result = await runPending(actor, emitter(req));
    await audit(req, {
      action: "migration.run",
      status: result.failed.length ? "error" : "ok",
      metadata: result,
    });
    return result;
  });


  app.post("/:version/rerun", async (req, reply) => {
    const p = z.object({ version: z.string().regex(/^[\w.-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_version" });
    const actor = req.auth?.user?.sub ?? "service_role";
    try {
      const row = await rerunOne(p.data.version, actor, emitter(req));
      await audit(req, { action: "migration.rerun", target: p.data.version });
      return { ok: true, row };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await audit(req, { action: "migration.rerun", target: p.data.version, status: "error", metadata: { message } });
      return reply.code(400).send({ error: "rerun_failed", message });
    }
  });

  app.post("/:version/rollback", async (req, reply) => {
    const p = z.object({ version: z.string().regex(/^[\w.-]+$/) }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid_version" });
    const actor = req.auth?.user?.sub ?? "service_role";
    try {
      const result = await rollback(p.data.version, actor, emitter(req));
      await audit(req, { action: "migration.rollback", target: p.data.version });
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await audit(req, { action: "migration.rollback", target: p.data.version, status: "error", metadata: { message } });
      return reply.code(400).send({ error: "rollback_failed", message });
    }
  });
}
