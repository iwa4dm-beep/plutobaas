// Edge Functions — user JavaScript executed in an isolated Node worker
// thread with wall-clock, memory and CPU caps. Per-invocation resource
// limits are enforced by both `worker.resourceLimits` (heap) and a
// hard `worker.terminate()` deadline (wall-clock). CPU time is bounded
// by wall-clock since Node workers do not expose a hard CPU quota; the
// vm context also disables `eval` / `wasm` to shrink the attack surface.
//
// Endpoints:
//   POST /functions/v1/deploy     { slug, code, public?, timeout_ms?, memory_mb?, allow_hosts? }
//   GET  /functions/v1/list
//   DELETE /functions/v1/:slug
//   ALL  /functions/v1/invoke/:slug

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { db } from "../../../db/index.js";
import { requireApiKey, requireServiceRole } from "../../../lib/apikey.js";
import { log } from "../../../lib/logs.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(HERE, "isolate-worker.cjs");

// Global caps — an admin can only pick values inside these bounds.
const MAX_TIMEOUT_MS = 15_000;
const MAX_MEMORY_MB = 128;
const DEFAULT_MEMORY_MB = 64;

type EdgeFn = {
  slug: string;
  code: string;
  timeout_ms: number;
  memory_mb: number;
  allow_hosts: string[];
  public: boolean;
};

type WorkerResult = { status?: number; headers?: Record<string, string>; body?: unknown };

async function runInWorker(fn: EdgeFn, req: FastifyRequest): Promise<WorkerResult> {
  const payload = {
    code: fn.code,
    allowHosts: fn.allow_hosts,
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
  };

  const worker = new Worker(WORKER_PATH, {
    workerData: payload,
    resourceLimits: {
      maxOldGenerationSizeMb: fn.memory_mb,
      maxYoungGenerationSizeMb: Math.min(16, Math.floor(fn.memory_mb / 4)),
      codeRangeSizeMb: 16,
    },
  });

  const deadline = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`timeout:${fn.timeout_ms}ms`)), fn.timeout_ms).unref();
  });

  const settled = new Promise<WorkerResult>((resolve, reject) => {
    worker.on("message", (msg: { type: string; result?: WorkerResult; message?: string; level?: string; args?: string[] }) => {
      if (msg.type === "log") {
        // Surface user logs into api_logs (fire-and-forget).
        void log("admin", (msg.level as "info" | "warn" | "error") ?? "info", `[${fn.slug}] ${msg.args?.join(" ") ?? ""}`);
      } else if (msg.type === "result") {
        resolve(msg.result ?? {});
      } else if (msg.type === "error") {
        reject(new Error(msg.message ?? "worker_error"));
      }
    });
    worker.on("error", reject);
    worker.on("exit", (code) => { if (code !== 0) reject(new Error(`worker_exit:${code}`)); });
  });

  try {
    return await Promise.race([settled, deadline]);
  } finally {
    // Whatever happened, tear the worker down so runaway loops die.
    await worker.terminate().catch(() => {});
  }
}

export async function edgeRoutes(app: FastifyInstance) {
  app.register(async (scoped) => {
    scoped.addHook("preHandler", requireApiKey);
    scoped.addHook("preHandler", async (req, reply) => { requireServiceRole(req, reply); });

    scoped.post("/deploy", async (req, reply) => {
      const body = z.object({
        slug: z.string().regex(/^[a-z0-9-]+$/).max(64),
        code: z.string().min(1).max(200_000),
        public: z.boolean().default(false),
        timeout_ms: z.number().int().min(100).max(MAX_TIMEOUT_MS).default(5_000),
        memory_mb: z.number().int().min(16).max(MAX_MEMORY_MB).default(DEFAULT_MEMORY_MB),
        allow_hosts: z.array(z.string()).max(32).default([]),
      }).safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body", issues: body.error.issues });

      await db.insertInto("edge_functions").values({
        slug: body.data.slug, code: body.data.code, runtime: "js",
        timeout_ms: body.data.timeout_ms,
        // memory_mb and allow_hosts columns are added in phase 6 migration
        // (see 0004_phase6.sql). Kysely typing falls through for extras.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...( { memory_mb: body.data.memory_mb, allow_hosts: body.data.allow_hosts } as any),
        public: body.data.public,
        created_by: req.auth?.user?.sub ?? null, updated_at: new Date(),
      }).onConflict((oc) => oc.column("slug").doUpdateSet({
        code: body.data.code, public: body.data.public,
        timeout_ms: body.data.timeout_ms,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...( { memory_mb: body.data.memory_mb, allow_hosts: body.data.allow_hosts } as any),
        updated_at: new Date(),
      })).execute();

      await log("admin", "info", `deployed edge fn ${body.data.slug}`, req.auth?.user?.sub ?? null);
      return { ok: true };
    });

    scoped.get("/list", async () => db.selectFrom("edge_functions").selectAll().execute());

    scoped.delete("/:slug", async (req) => {
      const { slug } = req.params as { slug: string };
      await db.deleteFrom("edge_functions").where("slug", "=", slug).execute();
      return { ok: true };
    });
  });

  app.all("/invoke/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const raw = await db.selectFrom("edge_functions").selectAll().where("slug", "=", slug).executeTakeFirst();
    if (!raw) return reply.code(404).send({ error: "not_found" });
    if (!raw.public) {
      await requireApiKey(req, reply);
      if (reply.sent) return;
    }
    const fn: EdgeFn = {
      slug: raw.slug,
      code: raw.code,
      timeout_ms: Math.min(raw.timeout_ms ?? 5000, MAX_TIMEOUT_MS),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      memory_mb: Math.min(((raw as any).memory_mb as number) ?? DEFAULT_MEMORY_MB, MAX_MEMORY_MB),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      allow_hosts: ((raw as any).allow_hosts as string[]) ?? [],
      public: raw.public,
    };
    const started = Date.now();
    try {
      const result = await runInWorker(fn, req);
      reply.code(result.status ?? 200);
      if (result.headers) reply.headers(result.headers);
      await log("admin", "info", `edge ${slug} ok in ${Date.now() - started}ms`);
      const { recordUsage } = await import("../../../lib/metering.js");
      void recordUsage({ workspaceId: req.auth?.workspaceId ?? null, metric: "function_invocations",
        quantity: 1, billingLabel: `fn:${slug}`, meta: { slug, ms: Date.now() - started } });
      return result.body ?? null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : "error";
      await log("admin", "error", `edge ${slug} failed after ${Date.now() - started}ms: ${msg}`);
      const { recordUsage } = await import("../../../lib/metering.js");
      void recordUsage({ workspaceId: req.auth?.workspaceId ?? null, metric: "function_invocations",
        quantity: 1, billingLabel: `fn:${slug}`, meta: { slug, ms: Date.now() - started, error: msg } });
      return reply.code(msg.startsWith("timeout") ? 504 : 500).send({ error: "invocation_failed", message: msg });
    }
  });
}
