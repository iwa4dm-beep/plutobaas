// Phase 34 — Data API surface: schema introspection, OpenAPI, GraphQL.
//
// Endpoints (gated by PLUTO_ENABLE_DATA_API=1):
//   GET  /rest/v1/                 — OpenAPI 3.1 document
//   GET  /rest/v1/introspect       — raw schema snapshot (JSON)
//   POST /graphql/v1               — GraphQL over public schema
//
// The REST CRUD surface itself remains in `modules/rest/routes.ts` — this
// module adds the discovery + GraphQL layer around it.

import type { FastifyPluginAsync } from "fastify";
import pg from "pg";
import { env } from "../../../config.js";
import { requireApiKey } from "../../../lib/apikey.js";
import { getSchemaSnapshot, invalidateSchemaCache } from "./introspect.js";
import { buildOpenApiDoc } from "./openapi.js";
import { executeGraphql } from "./graphql.js";

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });

export const dataApiPlugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_DATA_API !== "1") {
    app.log.info("[data_api] disabled (set PLUTO_ENABLE_DATA_API=1 to enable)");
    return;
  }

  app.get("/rest/v1/", { preHandler: requireApiKey }, async (req) => {
    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const host = (req.headers["x-forwarded-host"] as string) || req.headers.host || "localhost";
    return buildOpenApiDoc(`${proto}://${host}`);
  });

  app.get("/rest/v1/introspect", { preHandler: requireApiKey }, async (req) => {
    const force = (req.query as { refresh?: string }).refresh === "1";
    if (force) invalidateSchemaCache();
    return getSchemaSnapshot(force);
  });

  app.post("/graphql/v1", { preHandler: requireApiKey }, async (req, reply) => {
    const body = (req.body ?? {}) as { query?: string; variables?: Record<string, unknown> };
    if (typeof body.query !== "string") { reply.code(400); return { errors: [{ message: "missing_query" }] }; }
    const client = await pool.connect();
    try {
      await client.query("begin");
      if (req.auth?.apiKey !== "service_role" && req.auth?.user) {
        await client.query("select set_config('pluto.user_id', $1, true)", [req.auth.user.sub]);
      }
      const out = await executeGraphql(body.query, body.variables ?? {}, { client });
      await client.query(out.errors ? "rollback" : "commit");
      if (out.errors) reply.code(200); // GraphQL convention: still 200
      return out;
    } catch (e) {
      await client.query("rollback").catch(() => {});
      return { errors: [{ message: (e as Error).message }] };
    } finally { client.release(); }
  });
};
