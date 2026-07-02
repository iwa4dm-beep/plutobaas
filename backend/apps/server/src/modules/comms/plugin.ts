/**
 * Fastify plugin — Communications module (Phase 14.0 skeleton).
 *
 * This file only wires the routes into the server and returns friendly
 * `501 Not Implemented` responses until Phase 14.1 lands the handlers.
 * Ship the plugin now so the OpenAPI/SDK generator and the frontend can
 * see the surface, and so the migration + RLS tests have somewhere to
 * point their integration probes.
 *
 * Enable with `PLUTO_ENABLE_COMMS=1`. Off by default so a stray call in
 * production doesn't create half-configured message rows.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { WEBHOOK_EVENTS } from "./types.js";

const notImpl = (feature: string) => ({
  error: "not_implemented",
  feature,
  phase: "14.0",
  message: `${feature} lands in Phase 14.1. See docs/PHASE-14.md for the roadmap.`,
});

export const commsPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_COMMS !== "1") {
    app.log.info({ module: "comms" }, "comms module disabled (set PLUTO_ENABLE_COMMS=1 to enable)");
    return;
  }

  app.log.info({ module: "comms", phase: "14.0" }, "comms module registered (skeleton)");

  // Discovery — safe, no side effects. Real handlers replace these in 14.1.
  app.get("/comms/v1/events", async () => ({ events: WEBHOOK_EVENTS }));

  // Email
  app.post("/comms/v1/email/send", async (_req, reply) => reply.code(501).send(notImpl("email.send")));
  app.get ("/comms/v1/email",       async (_req, reply) => reply.code(501).send(notImpl("email.list")));

  // SMS
  app.post("/comms/v1/sms/send",    async (_req, reply) => reply.code(501).send(notImpl("sms.send")));
  app.get ("/comms/v1/sms",         async (_req, reply) => reply.code(501).send(notImpl("sms.list")));

  // Webhooks
  app.get   ("/comms/v1/webhooks",                                    async (_req, reply) => reply.code(501).send(notImpl("webhooks.list")));
  app.post  ("/comms/v1/webhooks",                                    async (_req, reply) => reply.code(501).send(notImpl("webhooks.create")));
  app.patch ("/comms/v1/webhooks/:id",                                async (_req, reply) => reply.code(501).send(notImpl("webhooks.update")));
  app.delete("/comms/v1/webhooks/:id",                                async (_req, reply) => reply.code(501).send(notImpl("webhooks.delete")));
  app.post  ("/comms/v1/webhooks/:id/test",                           async (_req, reply) => reply.code(501).send(notImpl("webhooks.test")));
  app.get   ("/comms/v1/webhooks/:id/deliveries",                     async (_req, reply) => reply.code(501).send(notImpl("webhooks.deliveries")));
  app.post  ("/comms/v1/webhooks/:id/deliveries/:did/retry",          async (_req, reply) => reply.code(501).send(notImpl("webhooks.retry")));
};

export default commsPlugin;
