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
  const row = await db
    .selectFrom("workspace_api_keys as k" as never)
    .innerJoin("workspaces as w" as never, "w.id" as never, "k.workspace_id" as never)
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
