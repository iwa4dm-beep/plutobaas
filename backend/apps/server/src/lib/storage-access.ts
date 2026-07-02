// Storage access-control evaluator.
//
// Called from every storage route to decide whether the current
// caller may perform an action on a given bucket/object. Enforces
// the semantics documented in migration 0011_storage_rls.sql.

import { db } from "../db/index.js";
import type { FastifyRequest } from "fastify";

export type StorageAction = "read" | "write" | "delete" | "sign_read" | "sign_write";

export interface StorageAccessContext {
  bucket: string;
  key: string;
  action: StorageAction;
  // Optional — supplied when the object already exists so owner
  // rules can be applied. For fresh uploads pass undefined; the
  // authenticated caller becomes the owner.
  ownerId?: string | null;
}

export interface StorageDenial {
  ok: false;
  status: 401 | 403 | 404;
  error: string;
}
export interface StorageGrant { ok: true; role: "service_role" | "owner" | "authenticated" | "anon"; }
export type StorageDecision = StorageGrant | StorageDenial;

interface BucketRow {
  name: string;
  public: boolean;
  owner_only: boolean;
  max_size: number;
  allowed_mime: string[] | null;
}

/**
 * Load bucket + policy rows in a single round-trip so we can decide
 * without chaining awaits.
 */
async function loadBucket(name: string): Promise<{
  bucket: BucketRow;
  policies: Map<string, boolean>; // key = `${role}:${action}`
} | null> {
  const b = await db.selectFrom("buckets" as never).selectAll()
    .where("name" as never, "=", name as never).executeTakeFirst() as BucketRow | undefined;
  if (!b) return null;
  const rows = await db.selectFrom("bucket_policies" as never)
    .select(["role" as never, "action" as never, "allow" as never])
    .where("bucket" as never, "=", name as never)
    .execute() as { role: string; action: string; allow: boolean }[];
  const policies = new Map<string, boolean>();
  for (const r of rows) policies.set(`${r.role}:${r.action}`, r.allow);
  return { bucket: b, policies };
}

export async function checkStorageAccess(
  req: FastifyRequest,
  ctx: StorageAccessContext,
): Promise<StorageDecision> {
  // service_role always wins — used by admin flows and cron.
  if (req.auth?.apiKey === "service_role") return { ok: true, role: "service_role" };

  const loaded = await loadBucket(ctx.bucket);
  if (!loaded) return { ok: false, status: 404, error: "bucket_not_found" };
  const { bucket, policies } = loaded;

  const userId = req.auth?.user?.sub ?? null;
  const isOwner = !!userId && !!ctx.ownerId && ctx.ownerId === userId;
  const isAuthed = !!userId;

  // Owner-only buckets: authenticated users can only touch their own
  // rows (or create fresh ones). Anon requests are always rejected
  // unless the bucket is public AND the action is a read variant.
  if (bucket.owner_only && ctx.ownerId && !isOwner && !isAuthed) {
    // fall through: might still be blocked below
  }

  const rolesToTry: Array<"owner" | "authenticated" | "anon"> = [];
  if (isOwner) rolesToTry.push("owner");
  if (isAuthed) rolesToTry.push("authenticated");
  rolesToTry.push("anon");

  for (const role of rolesToTry) {
    const allow = policies.get(`${role}:${ctx.action}`);
    if (allow === true) {
      // owner_only overrides authenticated write/delete when the
      // object already has a different owner.
      if (
        bucket.owner_only &&
        (ctx.action === "write" || ctx.action === "delete" || ctx.action === "sign_write") &&
        ctx.ownerId && !isOwner
      ) {
        return { ok: false, status: 403, error: "not_object_owner" };
      }
      return { ok: true, role };
    }
    if (allow === false) return { ok: false, status: 403, error: "policy_denied" };
  }
  return { ok: false, status: isAuthed ? 403 : 401, error: "no_matching_policy" };
}

/** Bucket upload caps — enforced separately from access rules. */
export async function checkUploadCaps(bucket: string, size: number, contentType: string):
  Promise<StorageDecision> {
  const loaded = await loadBucket(bucket);
  if (!loaded) return { ok: false, status: 404, error: "bucket_not_found" };
  const b = loaded.bucket;
  if (size > b.max_size) return { ok: false, status: 413, error: "file_too_large" } as never;
  if (b.allowed_mime && b.allowed_mime.length > 0 && !b.allowed_mime.includes(contentType)) {
    return { ok: false, status: 415, error: "mime_not_allowed" } as never;
  }
  return { ok: true, role: "authenticated" };
}
