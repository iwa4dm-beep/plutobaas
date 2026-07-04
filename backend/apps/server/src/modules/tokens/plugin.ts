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

  // Test endpoint for token scope enforcement — echoes the scopes the
  // caller's bearer resolved to. Useful for verifying a freshly minted
  // token works before wiring it into external clients.
  app.get("/tokens/v1/whoami", { preHandler: [requireScope("usage:read")] }, async (req) => {
    return { workspace_id: req.token?.workspace_id ?? null, scopes: req.token?.scopes ?? [] };
  });
}
