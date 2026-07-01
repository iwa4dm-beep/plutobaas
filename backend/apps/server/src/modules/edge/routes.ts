// Edge Functions — user-authored JavaScript executed in an isolated
// node:vm context on demand. NOT a full sandbox; use for trusted code
// authored by admins. For untrusted code, run inside an isolate worker.
//
//   POST /functions/v1/deploy   { slug, code, public? }   (service-role)
//   GET  /functions/v1/list                               (service-role)
//   DELETE /functions/v1/:slug                            (service-role)
//   ALL  /functions/v1/invoke/:slug                       (public if fn.public)
//
// The function code must export a default async handler:
//   export default async ({ req, ctx }) => ({ status: 200, body: {...} })

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import vm from "node:vm";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireServiceRole } from "../../lib/apikey.js";
import { log } from "../../lib/logs.js";

type Handler = (arg: {
  req: { method: string; url: string; headers: Record<string, unknown>; body: unknown };
  ctx: { user: { id: string; role: string } | null; env: Record<string, string> };
}) => Promise<{ status?: number; headers?: Record<string, string>; body?: unknown }>;

async function loadHandler(code: string): Promise<Handler> {
  // Wrap the user code into a CommonJS-ish module so it can `export default`.
  const wrapped = `
    const module = { exports: {} };
    const exports = module.exports;
    ${code}
    ;module.exports.__default = module.exports.default ?? module.exports;
    module.exports;
  `;
  const context = vm.createContext({ console, fetch, URL, TextEncoder, TextDecoder, crypto });
  const script = new vm.Script(wrapped, { filename: "edge-fn.js" });
  const mod = script.runInContext(context, { timeout: 500 }) as { __default: Handler };
  if (typeof mod.__default !== "function") throw new Error("no_default_export");
  return mod.__default;
}

async function invoke(fn: { slug: string; code: string; timeout_ms: number }, req: FastifyRequest, reply: FastifyReply) {
  const handler = await loadHandler(fn.code);
  const result = await Promise.race([
    handler({
      req: {
        method: req.method,
        url: req.url,
        headers: req.headers as Record<string, unknown>,
        body: req.body,
      },
      ctx: {
        user: req.auth?.user ? { id: req.auth.user.sub, role: req.auth.user.role } : null,
        env: { PLUTO_FUNCTION: fn.slug },
      },
    }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), fn.timeout_ms)),
  ]);
  reply.code(result.status ?? 200);
  if (result.headers) reply.headers(result.headers);
  return result.body ?? null;
}

export async function edgeRoutes(app: FastifyInstance) {
  // Deploy / list / delete require the api-key + service role.
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);
    scoped.addHook("preHandler", async (req, reply) => { requireServiceRole(req, reply); });

    scoped.post("/deploy", async (req, reply) => {
      const body = z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/).max(64),
        code: z.string().min(1).max(200_000),
        public: z.boolean().default(false),
        timeout_ms: z.number().int().min(100).max(30_000).default(5000),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      try { await loadHandler(body.data.code); }
      catch (e) { return reply.code(400).send({ error: "compile_error", message: (e as Error).message }); }
      await db.insertInto("edge_functions").values({
        slug: body.data.slug, code: body.data.code, runtime: "js",
        timeout_ms: body.data.timeout_ms, public: body.data.public,
        created_by: req.auth?.user?.sub ?? null, updated_at: new Date(),
      }).onConflict((oc) => oc.column("slug").doUpdateSet({
        code: body.data.code, public: body.data.public, timeout_ms: body.data.timeout_ms, updated_at: new Date(),
      })).execute();
      await log("admin", "info", `deployed edge fn ${body.data.slug}`, req.auth?.user?.sub ?? null);
      return { ok: true };
    });

    scoped.get("/list", async () => db.selectFrom("edge_functions").select(["slug", "public", "timeout_ms", "updated_at"]).execute());

    scoped.delete("/:slug", async (req) => {
      const { slug } = req.params as { slug: string };
      await db.deleteFrom("edge_functions").where("slug", "=", slug).execute();
      return { ok: true };
    });
  });

  // Invocation: public if the function is marked public, else requires api-key.
  app.all("/invoke/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const fn = await db.selectFrom("edge_functions").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!fn) return reply.code(404).send({ error: "not_found" });
    if (!fn.public) {
      await requireApiKey(req, reply);
      if (reply.sent) return;
    }
    try { return await invoke(fn, req, reply); }
    catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      await log("admin", "error", `edge fn ${slug} failed: ${msg}`);
      return reply.code(500).send({ error: "invocation_failed", message: msg });
    }
  });
}
