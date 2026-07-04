// Phase 45 — Edge Runtime v4 (deno-subhosting parity).
//
// Endpoints (gated by PLUTO_ENABLE_EDGE_V4=1):
//
//   Deployments
//     POST   /fn/v4/deployments                    — bundle{ slug, entry, files, imports, env, ... }
//     GET    /fn/v4/deployments?slug=              — list versions
//     POST   /fn/v4/deployments/:id/activate       — flip active + traffic_pct
//     POST   /fn/v4/deployments/:id/rollback       — mark inactive
//
//   Secrets (per-fn or workspace-wide when slug is null)
//     PUT    /fn/v4/secrets                        — { slug?, name, value }
//     GET    /fn/v4/secrets?slug=                  — names only (never values)
//     DELETE /fn/v4/secrets                        — { slug?, name }
//
//   Imports
//     POST   /fn/v4/imports/resolve                — resolve+cache { specifier }
//     GET    /fn/v4/imports                        — cached resolutions
//
//   Domains
//     POST   /fn/v4/domains                        — { hostname, slug, path_prefix? }
//     GET    /fn/v4/domains
//     DELETE /fn/v4/domains/:id
//
//   Cron
//     POST   /fn/v4/cron                           — { slug, cron_expr }
//     GET    /fn/v4/cron
//     POST   /fn/v4/cron/tick                      — run due schedules (admin)
//
//   Invoke
//     ALL    /fn/v4/invoke/:slug                   — resolve → assemble → isolate
//     GET    /fn/v4/logs?slug=                     — recent invocations

import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { aesEncrypt, aesDecrypt } from "../../lib/aes.js";
import { resolveImport, resolveImportMap } from "../../lib/import-resolver.js";
import { parseCron, nextRunAt } from "../../lib/cron.js";
import { audit } from "../../lib/audit.js";
import { invokeIsolate } from "../edge_v3/isolate.js";

const SLUG = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;

function wsFor(req: FastifyRequest): string | null {
  return (req.headers["x-workspace-id"] as string) ?? req.auth?.workspaceId ?? null;
}

/** Decrypt every secret in scope (fn-specific overrides workspace-wide). */
async function loadSecretsFor(workspaceId: string | null, slug: string): Promise<Record<string, string>> {
  const rows = await db.selectFrom("fn_v4_secrets" as never)
    .select(["slug" as never, "name" as never, "ciphertext" as never])
    .where("workspace_id" as never, "is not distinct from", workspaceId as never)
    .execute() as unknown as Array<{ slug: string | null; name: string; ciphertext: string }>;
  const out: Record<string, string> = {};
  // workspace-wide first, then per-fn overrides
  for (const r of rows.sort((a, b) => (a.slug ? 1 : 0) - (b.slug ? 1 : 0))) {
    if (r.slug && r.slug !== slug) continue;
    try {
      const buf = Buffer.from(r.ciphertext, "base64");
      const nonce = buf.subarray(0, 12);
      const ct    = buf.subarray(12);
      out[r.name] = aesDecrypt(ct, nonce).toString("utf-8");
    } catch { /* skip unreadable secrets */ }
  }
  return out;
}

/** Assemble a runnable module: prepend resolved import shim + inline files. */
function assembleBundle(files: Record<string, string>, entry: string, imports: Record<string, { resolved_url: string }>): string {
  const importStubs = Object.entries(imports)
    .map(([k, v]) => `// import "${k}" -> ${v.resolved_url}`)
    .join("\n");
  const filesJson = JSON.stringify(files);
  return `${importStubs}
const __files = ${filesJson};
const __entry = ${JSON.stringify(entry)};
// User bundle: eval-free — the isolate loads the entry file body directly.
${files[entry] ?? ""}
`;
}

export const edgeV4Plugin: FastifyPluginAsync = async (app) => {
  if (process.env.PLUTO_ENABLE_EDGE_V4 !== "1") {
    app.log.info("[edge4] disabled (set PLUTO_ENABLE_EDGE_V4=1 to enable)");
    return;
  }
  app.addHook("preHandler", requireApiKey);

  // ============== Deployments ==============

  app.post("/fn/v4/deployments", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      slug:        z.string().regex(SLUG),
      entry:       z.string().default("index.ts"),
      files:       z.record(z.string().max(1_000_000)).refine(o => Object.keys(o).length > 0, "at least one file"),
      imports:     z.record(z.string()).default({}),
      env:         z.record(z.string()).default({}),
      timeout_ms:  z.number().int().min(50).max(30_000).default(5000),
      memory_mb:   z.number().int().min(32).max(1024).default(128),
      allow_hosts: z.array(z.string()).max(64).default([]),
      traffic_pct: z.number().int().min(0).max(100).default(100),
      activate:    z.boolean().default(true),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    if (!body.data.files[body.data.entry])
      return reply.code(400).send({ error: "entry_not_in_files", entry: body.data.entry });

    const ws = wsFor(req);
    // Resolve imports up-front so bad specifiers fail the deploy, not the first invoke.
    let resolved: Record<string, { resolved_url: string }>;
    try { resolved = await resolveImportMap(body.data.imports); }
    catch (e) { return reply.code(400).send({ error: "import_resolve_failed", message: (e as Error).message }); }

    const maxRow = await db.selectFrom("fn_v4_deployments" as never)
      .select(["version" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("slug" as never, "=", body.data.slug as never)
      .orderBy("version" as never, "desc").limit(1).executeTakeFirst() as unknown as { version: number } | undefined;
    const version = (maxRow?.version ?? 0) + 1;

    if (body.data.activate) {
      await db.updateTable("fn_v4_deployments" as never).set({ active: false } as never)
        .where("workspace_id" as never, "is not distinct from", ws as never)
        .where("slug" as never, "=", body.data.slug as never).execute();
    }

    const row = await db.insertInto("fn_v4_deployments" as never).values({
      workspace_id: ws, slug: body.data.slug, version, entry: body.data.entry,
      files: body.data.files, imports: Object.fromEntries(
        Object.entries(resolved).map(([k, v]) => [k, v.resolved_url])
      ),
      env: body.data.env, timeout_ms: body.data.timeout_ms, memory_mb: body.data.memory_mb,
      allow_hosts: body.data.allow_hosts, traffic_pct: body.data.traffic_pct,
      active: body.data.activate, created_by: req.auth?.user?.sub ?? null,
    } as never).returning(["id" as never]).executeTakeFirst() as unknown as { id: string };

    await audit(req, { action: "edge.v4.deploy", status: "ok",
      metadata: { slug: body.data.slug, version, id: row.id, imports: Object.keys(resolved).length } });
    return { id: row.id, slug: body.data.slug, version, imports: resolved };
  });

  app.get("/fn/v4/deployments", async (req) => {
    const q = req.query as { slug?: string };
    const ws = wsFor(req);
    let base = db.selectFrom("fn_v4_deployments" as never)
      .select([
        "id" as never, "slug" as never, "version" as never, "entry" as never,
        "timeout_ms" as never, "memory_mb" as never, "allow_hosts" as never,
        "traffic_pct" as never, "active" as never, "created_at" as never,
      ])
      .where("workspace_id" as never, "is not distinct from", ws as never);
    if (q.slug) base = base.where("slug" as never, "=", q.slug as never);
    const rows = await base.orderBy("slug" as never, "asc").orderBy("version" as never, "desc").execute();
    return { deployments: rows };
  });

  app.post("/fn/v4/deployments/:id/activate", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ traffic_pct: z.number().int().min(0).max(100).default(100) })
      .safeParse(req.body ?? {});
    const dep = await db.selectFrom("fn_v4_deployments" as never).selectAll()
      .where("id" as never, "=", id as never).executeTakeFirst() as
      { workspace_id: string | null; slug: string } | undefined;
    if (!dep) return { ok: false, error: "not_found" };
    await db.updateTable("fn_v4_deployments" as never).set({ active: false } as never)
      .where("workspace_id" as never, "is not distinct from", dep.workspace_id as never)
      .where("slug" as never, "=", dep.slug as never).execute();
    await db.updateTable("fn_v4_deployments" as never).set({
      active: true, traffic_pct: body.success ? body.data.traffic_pct : 100,
    } as never).where("id" as never, "=", id as never).execute();
    await audit(req, { action: "edge.v4.activate", status: "ok", metadata: { id } });
    return { ok: true };
  });

  app.post("/fn/v4/deployments/:id/rollback", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    await db.updateTable("fn_v4_deployments" as never).set({ active: false } as never)
      .where("id" as never, "=", id as never).execute();
    await audit(req, { action: "edge.v4.rollback", status: "ok", metadata: { id } });
    return { ok: true };
  });

  // ============== Secrets ==============

  app.put("/fn/v4/secrets", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      slug:  z.string().regex(SLUG).nullable().optional(),
      name:  z.string().regex(NAME),
      value: z.string().min(1).max(24576),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const ws = wsFor(req);
    const enc = aesEncrypt(Buffer.from(body.data.value, "utf-8"));
    const ciphertext = Buffer.concat([enc.nonce, enc.ct]).toString("base64");

    await db.insertInto("fn_v4_secrets" as never).values({
      workspace_id: ws, slug: body.data.slug ?? null,
      name: body.data.name, ciphertext,
    } as never).onConflict((c: any): any =>
      (c as { columns: (k: string[]) => { doUpdateSet: (u: unknown) => unknown } })
        .columns(["workspace_id", "slug", "name"])
        .doUpdateSet({ ciphertext, updated_at: new Date() })).execute();
    await audit(req, { action: "edge.v4.secret.set", status: "ok",
      metadata: { name: body.data.name, slug: body.data.slug ?? null } });
    return { ok: true };
  });

  app.get("/fn/v4/secrets", async (req) => {
    const q = req.query as { slug?: string };
    const ws = wsFor(req);
    let base = db.selectFrom("fn_v4_secrets" as never)
      .select(["id" as never, "slug" as never, "name" as never, "updated_at" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never);
    if (q.slug) base = base.where("slug" as never, "=", q.slug as never);
    const rows = await base.orderBy("name" as never, "asc").execute();
    return { secrets: rows };  // values intentionally omitted
  });

  app.delete("/fn/v4/secrets", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      slug: z.string().regex(SLUG).nullable().optional(),
      name: z.string().regex(NAME),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const ws = wsFor(req);
    await db.deleteFrom("fn_v4_secrets" as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("slug" as never, "is not distinct from", (body.data.slug ?? null) as never)
      .where("name" as never, "=", body.data.name as never).execute();
    await audit(req, { action: "edge.v4.secret.delete", status: "ok", metadata: body.data });
    return { ok: true };
  });

  // ============== Imports ==============

  app.post("/fn/v4/imports/resolve", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({ specifier: z.string().min(1) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    try { return await resolveImport(body.data.specifier); }
    catch (e) { return reply.code(400).send({ error: "resolve_failed", message: (e as Error).message }); }
  });

  app.get("/fn/v4/imports", async () => {
    const rows = await db.selectFrom("fn_v4_imports" as never)
      .select(["specifier" as never, "resolved_url" as never, "integrity" as never,
              "size_bytes" as never, "cached_at" as never])
      .orderBy("cached_at" as never, "desc").limit(500).execute();
    return { imports: rows };
  });

  // ============== Domains ==============

  app.post("/fn/v4/domains", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      hostname:    z.string().regex(/^[a-z0-9.\-]+$/i).max(253),
      slug:        z.string().regex(SLUG),
      path_prefix: z.string().default("/"),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    const ws = wsFor(req);
    const row = await db.insertInto("fn_v4_domains" as never).values({
      workspace_id: ws, ...body.data,
    } as never).returning(["id" as never]).executeTakeFirst() as unknown as { id: string };
    await audit(req, { action: "edge.v4.domain.create", status: "ok", metadata: body.data });
    return { id: row.id };
  });

  app.get("/fn/v4/domains", async (req) => {
    const ws = wsFor(req);
    const rows = await db.selectFrom("fn_v4_domains" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("hostname" as never, "asc").execute();
    return { domains: rows };
  });

  app.delete("/fn/v4/domains/:id", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const { id } = req.params as { id: string };
    const ws = wsFor(req);
    await db.deleteFrom("fn_v4_domains" as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .execute();
    return { ok: true };
  });

  // ============== Cron ==============

  app.post("/fn/v4/cron", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      slug:      z.string().regex(SLUG),
      cron_expr: z.string().min(9).max(64),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body" });
    try { parseCron(body.data.cron_expr); }
    catch (e) { return reply.code(400).send({ error: "invalid_cron", message: (e as Error).message }); }
    const ws = wsFor(req);
    const next = nextRunAt(parseCron(body.data.cron_expr));
    const row = await db.insertInto("fn_v4_cron" as never).values({
      workspace_id: ws, slug: body.data.slug, cron_expr: body.data.cron_expr,
      next_run_at: next,
    } as never).returning(["id" as never]).executeTakeFirst() as unknown as { id: string };
    return { id: row.id, next_run_at: next.toISOString() };
  });

  app.get("/fn/v4/cron", async (req) => {
    const ws = wsFor(req);
    const rows = await db.selectFrom("fn_v4_cron" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .orderBy("next_run_at" as never, "asc").execute();
    return { schedules: rows };
  });

  app.post("/fn/v4/cron/tick", { preHandler: [requireWorkspaceAdmin] }, async (req) => {
    const now = new Date();
    const due = await db.selectFrom("fn_v4_cron" as never).selectAll()
      .where("enabled" as never, "=", true as never)
      .where("next_run_at" as never, "<=", now as never)
      .limit(50).execute() as unknown as
      Array<{ id: string; workspace_id: string | null; slug: string; cron_expr: string }>;
    for (const c of due) {
      try {
        await invokeSlug(c.workspace_id, c.slug, { triggered_by: "cron", request: null }, req);
      } catch { /* logged inside invokeSlug */ }
      const next = nextRunAt(parseCron(c.cron_expr));
      await db.updateTable("fn_v4_cron" as never)
        .set({ last_run_at: now, next_run_at: next } as never)
        .where("id" as never, "=", c.id as never).execute();
    }
    return { processed: due.length };
  });

  // ============== Invoke ==============

  async function invokeSlug(
    ws: string | null,
    slug: string,
    opts: { triggered_by: "http" | "cron" | "domain"; request: FastifyRequest | null },
    reqForAudit: FastifyRequest,
  ): Promise<{ status: number; body: unknown }> {
    const dep = await db.selectFrom("fn_v4_deployments" as never).selectAll()
      .where("workspace_id" as never, "is not distinct from", ws as never)
      .where("slug" as never, "=", slug as never)
      .where("active" as never, "=", true as never)
      .orderBy("version" as never, "desc").limit(1).executeTakeFirst() as
      | { id: string; entry: string; files: Record<string, string>; imports: Record<string, string>;
          env: Record<string, string>; timeout_ms: number; memory_mb: number; allow_hosts: string[] }
      | undefined;
    if (!dep) return { status: 404, body: { error: "no_active_deployment", slug } };

    const secrets = await loadSecretsFor(ws, slug);
    const importMap = Object.fromEntries(
      Object.entries(dep.imports).map(([k, url]) => [k, { resolved_url: url }])
    );
    const code = assembleBundle(dep.files, dep.entry, importMap);
    const req = opts.request;
    const res = await invokeIsolate({
      code,
      req: req
        ? { method: req.method, url: req.url, headers: req.headers as Record<string, string>, body: req.body }
        : { method: "POST", url: `/cron/${slug}`, headers: {}, body: {} },
      ctx: {
        workspace_id: ws, user_id: reqForAudit.auth?.user?.sub ?? null,
        env: { ...dep.env, ...secrets },
        imports: importMap,
      },
      timeoutMs: dep.timeout_ms, memoryMb: dep.memory_mb, allowHosts: dep.allow_hosts,
    });
    await db.insertInto("fn_v4_invocations" as never).values({
      deployment_id: dep.id, workspace_id: ws, slug,
      ok: res.ok, status: res.ok ? 200 : 500, duration_ms: res.durationMs,
      mem_peak_mb: res.memPeakMb, error: res.error ?? null,
      triggered_by: opts.triggered_by,
      request_headers: req ? sanitizeHeaders(req.headers as Record<string, unknown>) : null,
    } as never).execute();
    return res.ok
      ? { status: 200, body: { result: res.result, logs: res.logs, duration_ms: res.durationMs } }
      : { status: 500, body: { error: res.error, logs: res.logs } };
  }

  app.all("/fn/v4/invoke/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    if (!SLUG.test(slug)) return reply.code(400).send({ error: "invalid_slug" });
    const out = await invokeSlug(wsFor(req), slug, { triggered_by: "http", request: req }, req);
    reply.code(out.status); return out.body;
  });

  app.get("/fn/v4/logs", async (req) => {
    const q = req.query as { slug?: string; limit?: string };
    const ws = wsFor(req);
    const lim = Math.min(500, Number(q.limit) || 100);
    let base = db.selectFrom("fn_v4_invocations" as never)
      .select(["id" as never, "slug" as never, "ok" as never, "status" as never,
              "duration_ms" as never, "error" as never, "triggered_by" as never, "started_at" as never])
      .where("workspace_id" as never, "is not distinct from", ws as never);
    if (q.slug) base = base.where("slug" as never, "=", q.slug as never);
    const rows = await base.orderBy("started_at" as never, "desc").limit(lim).execute();
    return { invocations: rows };
  });
};

function sanitizeHeaders(h: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    if (/^(authorization|apikey|cookie|x-service-role-key)$/i.test(k)) out[k] = "[REDACTED]";
    else out[k] = v;
  }
  return out;
}
