// Advanced Auth plugin — mounts MFA, SSO, and Push handlers.
// Enable with PLUTO_ENABLE_ADVANCED_AUTH=1.
import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { mountMfa } from "./mfa.js";
import { mountSso } from "./sso.js";
import { mountPush } from "./push.js";

export const advancedAuthPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  if (process.env.PLUTO_ENABLE_ADVANCED_AUTH !== "1") {
    app.log.info({ module: "advanced_auth" }, "advanced_auth disabled (set PLUTO_ENABLE_ADVANCED_AUTH=1 to enable)");
    return;
  }
  app.log.info({ module: "advanced_auth", phase: "15.5" }, "advanced_auth registered (MFA + SSO + Push)");
  mountMfa(app);
  mountSso(app);
  mountPush(app);
};

export default advancedAuthPlugin;
