import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { env } from "../config.js";
import { verifyAccessToken, type AccessClaims } from "./jwt.js";
import { db } from "../db/index.js";

export type ApiKeyKind = "anon" | "service_role";

// Reserved workspace id for the env-provided ANON_KEY / SERVICE_ROLE_KEY.
// Matches the row seeded by migration 0006.
export const ROOT_WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";

export type RequestAuth = {
  apiKey: ApiKeyKind;
  workspaceId: string;
  workspaceSlug: string;
  keyId: string | null;     // null for env-provided root keys
  user: AccessClaims | null;
  /** Convenience aliases used by newer plugins. */
  userId?: string | null;
  role?: string | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

function sha256(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

// In-memory cache: sha256(plaintext) → resolved key row. Keeps hot paths
// off the DB; a mint/revoke clears the affected entry via bustKeyCache().
type CacheEntry = {
  kind: ApiKeyKind;
  workspaceId: string;
  workspaceSlug: string;
  keyId: string | null;
  cachedAt: number;
};
const keyCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function bustKeyCache(): void {
  keyCache.clear();
}

async function resolveKey(plaintext: string): Promise<CacheEntry | null> {
  // Env-provided keys resolve to the root workspace with no DB round-trip.
  if (plaintext === env.ANON_KEY) {
    return { kind: "anon", workspaceId: ROOT_WORKSPACE_ID, workspaceSlug: "root", keyId: null, cachedAt: Date.now() };
  }
  if (plaintext === env.SERVICE_ROLE_KEY) {
    return { kind: "service_role", workspaceId: ROOT_WORKSPACE_ID, workspaceSlug: "root", keyId: null, cachedAt: Date.now() };
  }
  const hit = keyCache.get(plaintext);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit;

  const hash = sha256(plaintext);
  const row = await (db as any)
    .selectFrom("workspace_api_keys as k")
    .innerJoin("workspaces as w", "w.id", "k.workspace_id")
    .select([
      "k.id as keyId" as never,
      "k.kind as kind" as never,
      "k.workspace_id as workspaceId" as never,
      "k.revoked_at as revokedAt" as never,
      "k.status as status" as never,
      "k.grace_expires_at as graceExpiresAt" as never,
      "w.slug as workspaceSlug" as never,
    ])
    .where("k.key_hash" as never, "=", hash as never)
    .executeTakeFirst() as
      | { keyId: string; kind: ApiKeyKind; workspaceId: string; revokedAt: Date | null;
          status: "active" | "rotating" | "revoked"; graceExpiresAt: Date | null; workspaceSlug: string }
      | undefined;

  if (!row || row.revokedAt || row.status === "revoked") return null;
  // Rotating keys are honoured only until their grace window closes.
  if (row.status === "rotating") {
    if (!row.graceExpiresAt || row.graceExpiresAt.getTime() < Date.now()) return null;
  }

  const entry: CacheEntry = {
    kind: row.kind,
    workspaceId: row.workspaceId,
    workspaceSlug: row.workspaceSlug,
    keyId: row.keyId,
    cachedAt: Date.now(),
  };
  keyCache.set(plaintext, entry);

  // Fire-and-forget usage bookkeeping.
  void db
    .updateTable("workspace_api_keys" as never)
    .set({ last_used_at: new Date(), use_count: (v: unknown) => `${v} + 1` } as never)
    .where("id" as never, "=", row.keyId as never)
    .execute()
    .catch(() => undefined);

  return entry;
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.headers["apikey"] ?? req.headers["x-api-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    reply.code(401).send({ error: "missing_api_key" });
    return;
  }
  const resolved = await resolveKey(value);
  if (!resolved) {
    reply.code(401).send({ error: "invalid_api_key" });
    return;
  }

  let user: AccessClaims | null = null;
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ") && authz.slice(7) !== value) {
    try {
      user = await verifyAccessToken(authz.slice(7));
    } catch {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }
  }
  req.auth = {
    apiKey: resolved.kind,
    workspaceId: resolved.workspaceId,
    workspaceSlug: resolved.workspaceSlug,
    keyId: resolved.keyId,
    user,
    userId: user?.sub ?? null,
    role: user?.role ?? null,
  };
}

export function requireServiceRole(req: FastifyRequest, reply: FastifyReply): void {
  if (req.auth?.apiKey !== "service_role") {
    reply.code(403).send({ error: "service_role_required" });
  }
}

// Strict guard for dashboard mutations: caller MUST present the
// service-role api key AND a valid JWT bearer whose `role` claim is
// "admin". This means a leaked service-role key alone is not enough —
// an active admin session is also required.
export function requireAdmin(req: FastifyRequest, reply: FastifyReply): void {
  if (req.auth?.apiKey !== "service_role") {
    reply.code(403).send({ error: "service_role_required" });
    return;
  }
  if (!req.auth.user) {
    reply.code(401).send({ error: "admin_session_required" });
    return;
  }
  if (req.auth.user.role !== "admin") {
    reply.code(403).send({ error: "admin_role_required" });
  }
}

// Phase 22 — Workspace-scoped RBAC gate for privileged mutations
// (quota editing, schema apply, branch apply). The caller may pass any
// api key, but the session user MUST be either:
//   • a global admin (auth.user.role === "admin"), OR
//   • an owner/admin in public.workspace_members for the target workspace.
// The service_role api key alone also grants access — it's already a
// privileged system credential and matches the existing admin surfaces.
export async function requireWorkspaceAdmin(
  req: FastifyRequest, reply: FastifyReply,
): Promise<void> {
  if (req.auth?.apiKey === "service_role") return;
  const user = req.auth?.user;
  if (!user) { reply.code(401).send({ error: "auth_required" }); return; }
  if (user.role === "admin") return;
  const raw = req.headers["x-workspace-id"];
  const ws = Array.isArray(raw) ? raw[0] : raw;
  if (!ws) { reply.code(400).send({ error: "workspace_required" }); return; }
  const row = await db
    .selectFrom("workspace_members as m" as never)
    .select(["m.role as role" as never])
    .where("m.workspace_id" as never, "=", ws as never)
    .where("m.user_id" as never, "=", user.sub as never)
    .executeTakeFirst() as { role: string } | undefined;
  if (row && (row.role === "owner" || row.role === "admin")) return;
  reply.code(403).send({ error: "workspace_admin_required" });
}

// Returns the caller's effective role in the workspace context of the request.
// Used by the dashboard to decide which controls to enable.
export async function resolveWorkspaceRole(
  req: FastifyRequest,
): Promise<"owner" | "admin" | "member" | "viewer" | "global_admin" | "service_role" | "anon"> {
  if (req.auth?.apiKey === "service_role") return "service_role";
  const user = req.auth?.user;
  if (!user) return "anon";
  if (user.role === "admin") return "global_admin";
  const raw = req.headers["x-workspace-id"];
  const ws = Array.isArray(raw) ? raw[0] : raw;
  if (!ws) return "member";
  const row = await db
    .selectFrom("workspace_members as m" as never)
    .select(["m.role as role" as never])
    .where("m.workspace_id" as never, "=", ws as never)
    .where("m.user_id" as never, "=", user.sub as never)
    .executeTakeFirst() as { role: string } | undefined;
  return (row?.role as "owner" | "admin" | "member" | "viewer") ?? "member";
}



// Phase 65 — Domain-admin gate. Anyone allowed by requireWorkspaceAdmin,
// PLUS users explicitly granted domain-admin for the target workspace via
// public.workspace_domain_admins. Used for custom-domain mutations only.
export async function requireDomainAdmin(
  req: FastifyRequest, reply: FastifyReply,
): Promise<void> {
  if (req.auth?.apiKey === "service_role") return;
  const user = req.auth?.user;
  if (!user) { reply.code(401).send({ error: "auth_required" }); return; }
  if (user.role === "admin") return;
  const raw = req.headers["x-workspace-id"];
  const ws = Array.isArray(raw) ? raw[0] : raw;
  if (!ws) { reply.code(400).send({ error: "workspace_required" }); return; }
  const memberRow = await db
    .selectFrom("workspace_members as m" as never)
    .select(["m.role as role" as never])
    .where("m.workspace_id" as never, "=", ws as never)
    .where("m.user_id" as never, "=", user.sub as never)
    .executeTakeFirst() as { role: string } | undefined;
  if (memberRow && (memberRow.role === "owner" || memberRow.role === "admin")) return;
  const grant = await db
    .selectFrom("workspace_domain_admins as g" as never)
    .select(["g.user_id as user_id" as never])
    .where("g.workspace_id" as never, "=", ws as never)
    .where("g.user_id" as never, "=", user.sub as never)
    .executeTakeFirst() as { user_id: string } | undefined;
  if (grant) return;
  reply.code(403).send({ error: "domain_admin_required" });
}

// Returns true if the current caller is granted domain-admin on the request's
// workspace (independent of workspace_members role). Used by /me endpoints.
export async function isDomainAdmin(req: FastifyRequest): Promise<boolean> {
  if (req.auth?.apiKey === "service_role") return true;
  const user = req.auth?.user;
  if (!user) return false;
  if (user.role === "admin") return true;
  const raw = req.headers["x-workspace-id"];
  const ws = Array.isArray(raw) ? raw[0] : raw;
  if (!ws) return false;
  const grant = await db
    .selectFrom("workspace_domain_admins as g" as never)
    .select(["g.user_id as user_id" as never])
    .where("g.workspace_id" as never, "=", ws as never)
    .where("g.user_id" as never, "=", user.sub as never)
    .executeTakeFirst() as { user_id: string } | undefined;
  return Boolean(grant);
}

