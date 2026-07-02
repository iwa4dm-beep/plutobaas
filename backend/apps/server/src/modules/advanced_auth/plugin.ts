/**
 * Fastify plugin — Advanced Auth (Phase 15.0 skeleton).
 *
 * Wires MFA, SSO, and Push notification routes into the server surface.
 * Returns friendly `501 Not Implemented` responses until Phase 15.1+ ships
 * the handlers. The OpenAPI + SDK generator picks up the routes today so
 * the frontend can be built against the final shape.
 *
 * Enable with `PLUTO_ENABLE_ADVANCED_AUTH=1`. Off by default — a stray
 * MFA/SSO call in production must never create half-configured rows.
 */
import type { FastifyInstance, FastifyPluginAsync } from "fastify";

const notImpl = (feature: string, phase = "15.1") => ({
  error: "not_implemented",
  feature,
  phase,
  message: `${feature} lands in Phase ${phase}. See docs/PHASE-15.md.`,
});

export const advancedAuthPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_ADVANCED_AUTH !== "1") {
    app.log.info({ module: "advanced_auth" }, "advanced_auth disabled (set PLUTO_ENABLE_ADVANCED_AUTH=1 to enable)");
    return;
  }
  app.log.info({ module: "advanced_auth", phase: "15.0" }, "advanced_auth registered (skeleton)");

  // ---- MFA (TOTP) ----
  app.get   ("/auth/v1/mfa/factors",             async (_r, reply) => reply.code(501).send(notImpl("mfa.list")));
  app.post  ("/auth/v1/mfa/enroll",              async (_r, reply) => reply.code(501).send(notImpl("mfa.enroll")));
  app.post  ("/auth/v1/mfa/verify",              async (_r, reply) => reply.code(501).send(notImpl("mfa.verify")));
  app.post  ("/auth/v1/mfa/challenge",           async (_r, reply) => reply.code(501).send(notImpl("mfa.challenge")));
  app.post  ("/auth/v1/mfa/challenge/verify",    async (_r, reply) => reply.code(501).send(notImpl("mfa.challenge.verify")));
  app.delete("/auth/v1/mfa/factors/:id",         async (_r, reply) => reply.code(501).send(notImpl("mfa.revoke")));
  app.post  ("/auth/v1/mfa/recovery-codes",      async (_r, reply) => reply.code(501).send(notImpl("mfa.recovery_codes")));

  // ---- SSO (OIDC + SAML) ----
  app.get   ("/auth/v1/sso/providers",           async (_r, reply) => reply.code(501).send(notImpl("sso.list", "15.2")));
  app.post  ("/auth/v1/sso/providers",           async (_r, reply) => reply.code(501).send(notImpl("sso.create", "15.2")));
  app.patch ("/auth/v1/sso/providers/:id",       async (_r, reply) => reply.code(501).send(notImpl("sso.update", "15.2")));
  app.delete("/auth/v1/sso/providers/:id",       async (_r, reply) => reply.code(501).send(notImpl("sso.delete", "15.2")));
  app.get   ("/auth/v1/sso/:slug/start",         async (_r, reply) => reply.code(501).send(notImpl("sso.start", "15.2")));
  app.get   ("/auth/v1/sso/:slug/callback",      async (_r, reply) => reply.code(501).send(notImpl("sso.callback", "15.2")));
  app.post  ("/auth/v1/sso/:slug/acs",           async (_r, reply) => reply.code(501).send(notImpl("sso.saml.acs", "15.3")));

  // ---- Push ----
  app.get   ("/push/v1/devices",                 async (_r, reply) => reply.code(501).send(notImpl("push.devices.list", "15.5")));
  app.post  ("/push/v1/devices",                 async (_r, reply) => reply.code(501).send(notImpl("push.devices.register", "15.5")));
  app.delete("/push/v1/devices/:id",             async (_r, reply) => reply.code(501).send(notImpl("push.devices.remove", "15.5")));
  app.post  ("/push/v1/send",                    async (_r, reply) => reply.code(501).send(notImpl("push.send", "15.5")));
  app.get   ("/push/v1/messages",                async (_r, reply) => reply.code(501).send(notImpl("push.messages.list", "15.5")));
};

export default advancedAuthPlugin;
