/**
 * Fastify plugin — Comms Templates (Phase 15.4 skeleton).
 *
 * Versioned, workspace-scoped email/sms/push templates with Handlebars-lite
 * variable substitution. The auth flows (magic link, password reset,
 * verification) and the Communications module both resolve their outgoing
 * content through these templates so branding is centralized.
 *
 * Enable with `PLUTO_ENABLE_TEMPLATES=1`.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

const notImpl = (feature: string) => ({
  error: "not_implemented",
  feature,
  phase: "15.4",
  message: `${feature} lands in Phase 15.4. See docs/PHASE-15.md.`,
});

export const templatesPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_TEMPLATES !== "1") {
    app.log.info({ module: "templates" }, "templates disabled (set PLUTO_ENABLE_TEMPLATES=1 to enable)");
    return;
  }
  app.log.info({ module: "templates", phase: "15.0" }, "templates registered (skeleton)");

  app.get   ("/templates/v1",                    async (_r, reply) => reply.code(501).send(notImpl("templates.list")));
  app.post  ("/templates/v1",                    async (_r, reply) => reply.code(501).send(notImpl("templates.create")));
  app.get   ("/templates/v1/:slug",              async (_r, reply) => reply.code(501).send(notImpl("templates.get")));
  app.get   ("/templates/v1/:slug/versions",     async (_r, reply) => reply.code(501).send(notImpl("templates.versions")));
  app.post  ("/templates/v1/:slug/versions",     async (_r, reply) => reply.code(501).send(notImpl("templates.version.create")));
  app.post  ("/templates/v1/:slug/activate/:version", async (_r, reply) => reply.code(501).send(notImpl("templates.activate")));
  app.post  ("/templates/v1/:slug/preview",      async (_r, reply) => reply.code(501).send(notImpl("templates.preview")));
  app.delete("/templates/v1/:slug",              async (_r, reply) => reply.code(501).send(notImpl("templates.delete")));
};

export default templatesPlugin;
