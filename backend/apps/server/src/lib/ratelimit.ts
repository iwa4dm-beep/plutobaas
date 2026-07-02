// Brute-force protection for /auth/v1/sign-in and /auth/v1/refresh.
//
// Two independent buckets are checked on every attempt:
//   - per IP (fast, cheap — stops naive spray attacks)
//   - per email / per token-hash (protects individual accounts even
//     when the attacker rotates IPs)
//
// Buckets live in-memory with a sliding window of successive
// FAILED attempts. On success the bucket resets. Once the window is
// exceeded the caller is locked out for `lockoutMs`; every rejection
// is also persisted to public.auth_attempts for the dashboard.

import type { FastifyRequest } from "fastify";
import { db } from "../db/index.js";

export type AttemptKind  = "sign_in" | "refresh" | "sign_up";
export type AttemptOutcome =
  | "ok" | "bad_credentials" | "locked"
  | "invalid_token" | "rate_limited" | "error";

type Bucket = { count: number; firstAt: number; lockUntil: number };

const IP_LIMIT       = 20;           // failed attempts…
const IP_WINDOW_MS   = 60_000;       // …per minute per IP
const IP_LOCK_MS     = 5 * 60_000;   // then locked out for 5 min

const ACCT_LIMIT     = 8;            // failed attempts per account…
const ACCT_WINDOW_MS = 15 * 60_000;  // …per 15 min
const ACCT_LOCK_MS   = 15 * 60_000;  // then 15 min lockout

const ipBuckets   = new Map<string, Bucket>();
const acctBuckets = new Map<string, Bucket>();

function check(map: Map<string, Bucket>, key: string, limit: number, windowMs: number): { locked: boolean; retryAfterSec: number } {
  const now = Date.now();
  const b = map.get(key);
  if (b?.lockUntil && b.lockUntil > now) {
    return { locked: true, retryAfterSec: Math.ceil((b.lockUntil - now) / 1000) };
  }
  if (b && now - b.firstAt > windowMs) map.delete(key); // window expired → reset
  const cur = map.get(key);
  if (cur && cur.count >= limit) {
    return { locked: true, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  return { locked: false, retryAfterSec: 0 };
}

function bump(map: Map<string, Bucket>, key: string, limit: number, windowMs: number, lockMs: number) {
  const now = Date.now();
  const b = map.get(key);
  if (!b || now - b.firstAt > windowMs) {
    map.set(key, { count: 1, firstAt: now, lockUntil: 0 });
    return;
  }
  b.count += 1;
  if (b.count >= limit) b.lockUntil = now + lockMs;
}

function reset(map: Map<string, Bucket>, key: string) { map.delete(key); }

function ipKey(req: FastifyRequest): string { return req.ip ?? "unknown"; }
function acctKey(k: AttemptKind, id: string): string { return `${k}:${id.toLowerCase()}`; }

export type PreCheck = { ok: true } | { ok: false; retryAfterSec: number; reason: "ip_locked" | "account_locked" };

export function preCheck(req: FastifyRequest, kind: AttemptKind, subject: string | null): PreCheck {
  const ip = check(ipBuckets, ipKey(req), IP_LIMIT, IP_WINDOW_MS);
  if (ip.locked) return { ok: false, retryAfterSec: ip.retryAfterSec, reason: "ip_locked" };
  if (subject) {
    const acct = check(acctBuckets, acctKey(kind, subject), ACCT_LIMIT, ACCT_WINDOW_MS);
    if (acct.locked) return { ok: false, retryAfterSec: acct.retryAfterSec, reason: "account_locked" };
  }
  return { ok: true };
}

export async function recordFailure(req: FastifyRequest, kind: AttemptKind, subject: string | null, outcome: AttemptOutcome) {
  bump(ipBuckets, ipKey(req), IP_LIMIT, IP_WINDOW_MS, IP_LOCK_MS);
  if (subject) bump(acctBuckets, acctKey(kind, subject), ACCT_LIMIT, ACCT_WINDOW_MS, ACCT_LOCK_MS);
  await persist(req, kind, subject, outcome);
}

export async function recordSuccess(req: FastifyRequest, kind: AttemptKind, subject: string | null) {
  // A win resets the account bucket so a legit user isn't punished for
  // occasional typos. IP bucket keeps counting failures across accounts.
  if (subject) reset(acctBuckets, acctKey(kind, subject));
  await persist(req, kind, subject, "ok");
}

async function persist(req: FastifyRequest, kind: AttemptKind, subject: string | null, outcome: AttemptOutcome) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insertInto("auth_attempts" as never).values({
      kind, outcome,
      email:      kind === "refresh" ? null : subject,
      ip:         req.ip ?? null,
      user_agent: (req.headers["user-agent"] as string | undefined) ?? null,
    } as any).execute();
  } catch { /* best-effort */ }
}

// Test-only: expose reset for the unit tests.
export function _resetAllBuckets() { ipBuckets.clear(); acctBuckets.clear(); }
