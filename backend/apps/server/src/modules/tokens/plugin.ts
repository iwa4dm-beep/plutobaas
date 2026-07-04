// Phase 28 — Workspace API tokens with scopes.
//
// Tokens are formatted as `plt_<prefix>_<secret>`; only sha256(plaintext)
// is stored. Scopes are enforced by `requireScope(scope)` which can be
// attached to any route as a Fastify preHandler.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../../db/index.js";
import { requireApiKey, requireWorkspaceAdmin } from "../../lib/apikey.js";
import { audit } from "../../lib/audit.js";

const enabled = process.env.PLUTO_ENABLE_TOKENS !== "0"; // default on

// Curated scope catalog surfaced to the UI. `*` is a wildcard admin scope.
export const KNOWN_SCOPES = [
  "usage:read", "usage:write",
  "quotas:read", "quotas:write",
  "functions:read", "functions:invoke", "functions:write",
  "backups:read", "backups:restore",
  "logs:read",
  "schema:read", "schema:apply",
  "branches:read", "branches:write",
  "vector:read", "vector:write",
  "realtime:read", "realtime:write",
] as const;
export type Scope = (typeof KNOWN_SCOPES)[number] | "*";

type TokenRow = {
  id: string; workspace_id: string; name: string; prefix: string;
  scopes: string[]; created_at: Date; last_used_at: Date | null;
  expires_at: Date | null; revoked_at: Date | null;
};

declare module "fastify" {
  interface FastifyRequest {
    token?: { id: string; workspace_id: string; scopes: string[] };
  }
}

function sha256(v: string) { return createHash("sha256").update(v).digest("hex"); }
function mint(): { plaintext: string; prefix: string; hash: string } {
  const prefix = randomBytes(4).toString("hex"); // 8 chars
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `plt_${prefix}_${secret}`;
  return { plaintext, prefix, hash: sha256(plaintext) };
}

// Resolve a bearer token (if present) and stash it on req.token. Does
// NOT reject requests — routes that need a token call `requireScope`.
async function attachToken(req: FastifyRequest): Promise<void> {
  const authz = req.headers.authorization;
  if (!authz?.startsWith("Bearer plt_")) return;
  const plaintext = authz.slice(7);
  const hash = sha256(plaintext);
  const row = await db.selectFrom("workspace_tokens" as never)
    .select(["id" as never, "workspace_id" as never, "scopes" as never,
             "revoked_at" as never, "expires_at" as never])
    .where("token_hash" as never, "=", hash as never)
    .executeTakeFirst() as
      | { id: string; workspace_id: string; scopes: string[]; revoked_at: Date | null; expires_at: Date | null }
      | undefined;
  if (!row) return;
  if (row.revoked_at) return;
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return;
  req.token = { id: row.id, workspace_id: row.workspace_id, scopes: row.scopes ?? [] };
  void db.updateTable("workspace_tokens" as never)
    .set({ last_used_at: new Date() } as never)
    .where("id" as never, "=", row.id as never).execute().catch(() => undefined);
}

export function requireScope(scope: Scope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // service_role api key is a superuser credential — bypass scope check.
    if (req.auth?.apiKey === "service_role") return;
    await attachToken(req);
    const scopes = req.token?.scopes ?? [];
    if (scopes.includes("*") || scopes.includes(scope)) return;
    reply.code(403).send({ error: "insufficient_scope", required: scope });
  };
}

export async function tokensPlugin(app: FastifyInstance) {
  if (!enabled) return;
  app.addHook("preHandler", requireApiKey);
  // Attach token info so /me responses can reflect scopes when using a token.
  app.addHook("preHandler", attachToken);

  app.get("/tokens/v1/scopes", async () => ({ scopes: KNOWN_SCOPES }));

  app.get("/tokens/v1/tokens", async (req) => {
    const ws = req.auth?.workspaceId;
    if (!ws) return { tokens: [] };
    const rows = await db.selectFrom("workspace_tokens" as never)
      .select(["id" as never, "workspace_id" as never, "name" as never, "prefix" as never,
               "scopes" as never, "created_at" as never, "last_used_at" as never,
               "expires_at" as never, "revoked_at" as never])
      .where("workspace_id" as never, "=", ws as never)
      .orderBy("created_at" as never, "desc").execute() as TokenRow[];
    return { tokens: rows };
  });

  app.post("/tokens/v1/tokens", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(120),
      scopes: z.array(z.string().min(1).max(64)).min(1).max(32),
      expires_in_days: z.number().int().min(1).max(365).optional(),
    }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    const ws = req.auth?.workspaceId;
    if (!ws) return reply.code(400).send({ error: "workspace_required" });
    // Reject unknown scopes to stop typos from silently doing nothing.
    const invalid = body.data.scopes.filter(s => s !== "*" && !KNOWN_SCOPES.includes(s as typeof KNOWN_SCOPES[number]));
    if (invalid.length) return reply.code(400).send({ error: "unknown_scope", invalid });

    const m = mint();
    const expires_at = body.data.expires_in_days
      ? new Date(Date.now() + body.data.expires_in_days * 24 * 3600 * 1000)
      : null;
    const inserted = await db.insertInto("workspace_tokens" as never).values({
      workspace_id: ws, name: body.data.name, prefix: m.prefix, token_hash: m.hash,
      scopes: body.data.scopes, created_by: req.auth?.user?.sub ?? null, expires_at,
    } as never).returning(["id" as never]).executeTakeFirst() as { id: string };

    await audit(req, { action: "tokens.create", target: inserted.id, status: "ok",
      metadata: { workspace_id: ws, prefix: m.prefix, scopes: body.data.scopes, expires_at } });

    // Plaintext is shown ONCE — client must copy immediately.
    return { id: inserted.id, name: body.data.name, prefix: m.prefix,
             scopes: body.data.scopes, expires_at, token: m.plaintext };
  });

  app.delete("/tokens/v1/tokens/:id", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad_id" });
    const r = await db.updateTable("workspace_tokens" as never)
      .set({ revoked_at: new Date() } as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "=", req.auth!.workspaceId as never)
      .where("revoked_at" as never, "is", null as never)
      .executeTakeFirst() as { numUpdatedRows: bigint };
    if (r.numUpdatedRows === 0n) return reply.code(404).send({ error: "not_found" });
    await audit(req, { action: "tokens.revoke", target: id, status: "ok",
      metadata: { workspace_id: req.auth!.workspaceId } });
    return { ok: true };
  });

  // Bulk revoke — filter by scope, creator user, last-used cutoff, or a
  // caller-supplied id list. `dry_run: true` returns the matching token
  // set without mutating anything so the UI can preview the blast radius.
  app.post("/tokens/v1/tokens/bulk-revoke", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const body = z.object({
      scope:             z.string().min(1).max(64).optional(),
      created_by:        z.string().min(1).max(200).optional(),
      last_used_before:  z.string().datetime().optional(),
      never_used:        z.boolean().optional(),   // last_used_at IS NULL
      include_expired:   z.boolean().default(false),
      ids:               z.array(z.string().uuid()).max(500).optional(),
      dry_run:           z.boolean().default(false),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    const ws = req.auth?.workspaceId;
    if (!ws) return reply.code(400).send({ error: "workspace_required" });
    const f = body.data;
    const hasFilter = f.scope || f.created_by || f.last_used_before || f.never_used || (f.ids && f.ids.length);
    if (!hasFilter) return reply.code(400).send({ error: "filter_required",
      message: "Provide at least one of: scope, created_by, last_used_before, never_used, ids" });

    let q = db.selectFrom("workspace_tokens" as never)
      .select(["id" as never, "name" as never, "prefix" as never, "scopes" as never,
               "created_by" as never, "last_used_at" as never, "expires_at" as never])
      .where("workspace_id" as never, "=", ws as never)
      .where("revoked_at" as never, "is", null as never);
    if (f.ids?.length)         q = q.where("id" as never, "in", f.ids as never);
    if (f.created_by)          q = q.where("created_by" as never, "=", f.created_by as never);
    if (f.scope)               q = q.where("scopes" as never, "@>", [f.scope] as never);
    if (f.last_used_before)    q = q.where("last_used_at" as never, "<", new Date(f.last_used_before) as never);
    if (f.never_used)          q = q.where("last_used_at" as never, "is", null as never);
    if (!f.include_expired)    q = q.where((eb: unknown) => (eb as { or: (a: unknown[]) => unknown; eb: (a: string, b: string, c: unknown) => unknown; }).or([
      (eb as { eb: (a: string, b: string, c: unknown) => unknown }).eb("expires_at" as never, "is", null as never),
      (eb as { eb: (a: string, b: string, c: unknown) => unknown }).eb("expires_at" as never, ">", new Date() as never),
    ]));

    const matched = await q.execute() as Array<{
      id: string; name: string; prefix: string; scopes: string[];
      created_by: string | null; last_used_at: Date | null; expires_at: Date | null;
    }>;

    if (f.dry_run || matched.length === 0) {
      return { dry_run: true, matched: matched.length, tokens: matched, revoked: [] };
    }

    const ids = matched.map(m => m.id);
    await db.updateTable("workspace_tokens" as never)
      .set({ revoked_at: new Date() } as never)
      .where("id" as never, "in", ids as never)
      .where("workspace_id" as never, "=", ws as never)
      .execute();

    await audit(req, { action: "tokens.bulk_revoke", status: "ok",
      metadata: { workspace_id: ws, count: ids.length, filter: f,
                  revoked_ids: ids.slice(0, 100) } });

    return { dry_run: false, matched: matched.length, revoked: ids, tokens: matched };
  });

  // Test endpoint for token scope enforcement — echoes the scopes the
  // caller's bearer resolved to. Useful for verifying a freshly minted
  // token works before wiring it into external clients.
  app.get("/tokens/v1/whoami", { preHandler: [requireScope("usage:read")] }, async (req) => {
    return { workspace_id: req.token?.workspace_id ?? null, scopes: req.token?.scopes ?? [] };
  });

  // Static catalog of endpoints protected by each scope, surfaced to the
  // Tokens dashboard so operators can see exactly what a scope grants.
  app.get("/tokens/v1/coverage", async () => ({ coverage: SCOPE_COVERAGE }));

  // Rotate — mint a replacement token cloning the existing scopes/expiry,
  // return plaintext ONCE, then revoke the old token.
  app.post("/tokens/v1/tokens/:id/rotate", { preHandler: [requireWorkspaceAdmin] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(400).send({ error: "bad_id" });
    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      expires_in_days: z.number().int().min(1).max(365).optional(),
    }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad_body", issues: body.error.issues });
    const ws = req.auth?.workspaceId;
    if (!ws) return reply.code(400).send({ error: "workspace_required" });

    const old = await db.selectFrom("workspace_tokens" as never)
      .select(["id" as never, "name" as never, "scopes" as never,
               "expires_at" as never, "revoked_at" as never])
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "=", ws as never)
      .executeTakeFirst() as
        | { id: string; name: string; scopes: string[]; expires_at: Date | null; revoked_at: Date | null }
        | undefined;
    if (!old) return reply.code(404).send({ error: "not_found" });
    if (old.revoked_at) return reply.code(409).send({ error: "already_revoked" });

    const m = mint();
    const expires_at = body.data.expires_in_days
      ? new Date(Date.now() + body.data.expires_in_days * 24 * 3600 * 1000)
      : old.expires_at;
    const newName = body.data.name ?? `${old.name} (rotated ${new Date().toISOString().slice(0, 10)})`;

    const inserted = await db.insertInto("workspace_tokens" as never).values({
      workspace_id: ws, name: newName, prefix: m.prefix, token_hash: m.hash,
      scopes: old.scopes, created_by: req.auth?.user?.sub ?? null, expires_at,
    } as never).returning(["id" as never]).executeTakeFirst() as { id: string };

    await db.updateTable("workspace_tokens" as never)
      .set({ revoked_at: new Date() } as never)
      .where("id" as never, "=", id as never)
      .where("workspace_id" as never, "=", ws as never)
      .execute();

    await audit(req, { action: "tokens.rotate", target: inserted.id, status: "ok",
      metadata: { workspace_id: ws, replaced: id, prefix: m.prefix, scopes: old.scopes, expires_at } });

    return { id: inserted.id, name: newName, prefix: m.prefix,
             scopes: old.scopes, expires_at, token: m.plaintext, replaced_id: id };
  });
}

// Endpoint coverage per scope. Non-exhaustive but tracks the routes
// currently gated (or intended to be gated) by `requireScope`.
export const SCOPE_COVERAGE: Record<string, Array<{ method: string; path: string; description: string }>> = {
  "usage:read": [
    { method: "GET", path: "/tokens/v1/whoami", description: "Verify a token and inspect its scopes" },
    { method: "GET", path: "/usage/v1/summary", description: "Workspace usage totals" },
    { method: "GET", path: "/usage/v1/alerts", description: "Read alert events" },
  ],
  "usage:write":  [{ method: "PUT",  path: "/usage/v1/webhooks", description: "Configure usage webhook" }],
  "quotas:read":  [{ method: "GET",  path: "/quotas/v1", description: "Read workspace quotas" }],
  "quotas:write": [{ method: "PUT",  path: "/quotas/v1", description: "Update workspace quotas" }],
  "functions:read":   [{ method: "GET",  path: "/edge/v2/functions", description: "List edge functions" }],
  "functions:invoke": [{ method: "POST", path: "/edge/v2/invoke/:name", description: "Invoke an edge function" }],
  "functions:write":  [{ method: "PUT",  path: "/edge/v2/functions/:name", description: "Deploy or update a function" }],
  "backups:read":     [{ method: "GET",  path: "/backups/v1", description: "List backups" }],
  "backups:restore":  [{ method: "POST", path: "/backups/v1/:id/restore", description: "Trigger a backup restore" }],
  "logs:read": [
    { method: "GET",  path: "/logs/v1/search", description: "Query structured logs" },
    { method: "GET",  path: "/logs/v1/stream", description: "SSE tail of live logs" },
    { method: "POST", path: "/logs/v1/export", description: "Start a logs export job" },
  ],
  "schema:read":  [{ method: "GET",  path: "/schema/v1", description: "Introspect schema" }],
  "schema:apply": [{ method: "POST", path: "/schema/v1/apply", description: "Apply a schema migration" }],
  "branches:read":  [{ method: "GET",  path: "/branches/v1", description: "List branches" }],
  "branches:write": [{ method: "POST", path: "/branches/v1", description: "Create or merge branches" }],
  "vector:read":  [{ method: "POST", path: "/vector/v1/search", description: "Vector similarity search" }],
  "vector:write": [{ method: "POST", path: "/vector/v1/upsert", description: "Upsert vector embeddings" }],
  "realtime:read":  [{ method: "GET",  path: "/rt/v1/channels", description: "Inspect realtime channels" }],
  "realtime:write": [{ method: "POST", path: "/rt/v1/publish", description: "Publish realtime messages" }],
};

