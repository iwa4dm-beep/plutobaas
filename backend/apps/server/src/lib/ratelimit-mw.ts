// Beta blocker — per-IP and per-token leaky-bucket rate limiter.
//
// The existing `@fastify/rate-limit` middleware handles a global cap.
// This is a more granular limiter you attach to sensitive routes
// (auth, billing, admin) and to the AI / edge invoke paths where a
// runaway loop can cost real money.
//
// Two independent buckets per key:
//   * ip:<remote>    — per source IP
//   * tok:<sha256>   — per resolved API key (or bearer)
// When either exceeds its capacity the request rejects with 429 +
// Retry-After. In-memory only (single-instance); wire to Redis via the
// scaling module when running multi-instance.

import type { FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";

type Bucket = { tokens: number; updated: number };
const buckets = new Map<string, Bucket>();

// Config: capacity + refill (tokens per second).
export type LimitConfig = { capacity: number; refillPerSec: number };

// Env-driven overrides. Safe defaults chosen so a typical dashboard
// user never hits them, but a runaway loop from a leaked key is capped
// within seconds. Tune per deployment:
//
//   PLUTO_RL_IP_CAPACITY         (default 60)   burst per source IP
//   PLUTO_RL_IP_REFILL           (default 1)    sustained rps per IP
//   PLUTO_RL_TOKEN_CAPACITY      (default 600)  burst per API key / bearer
//   PLUTO_RL_TOKEN_REFILL        (default 10)   sustained rps per token
//   PLUTO_RL_STRICT_IP_CAPACITY  (default 20)   burst for AI / edge / backup
//   PLUTO_RL_STRICT_IP_REFILL    (default 0.3)  ~1 req / 3s sustained
//   PLUTO_RL_STRICT_TOK_CAPACITY (default 60)   token burst on strict routes
//   PLUTO_RL_STRICT_TOK_REFILL   (default 1)    sustained rps on strict routes
function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
export const DEFAULT_IP:  LimitConfig = {
  capacity:     num("PLUTO_RL_IP_CAPACITY", 60),
  refillPerSec: num("PLUTO_RL_IP_REFILL", 1),
};
export const DEFAULT_TOK: LimitConfig = {
  capacity:     num("PLUTO_RL_TOKEN_CAPACITY", 600),
  refillPerSec: num("PLUTO_RL_TOKEN_REFILL", 10),
};
export const STRICT_IP:  LimitConfig = {
  capacity:     num("PLUTO_RL_STRICT_IP_CAPACITY", 20),
  refillPerSec: num("PLUTO_RL_STRICT_IP_REFILL", 0.3),
};
export const STRICT_TOK: LimitConfig = {
  capacity:     num("PLUTO_RL_STRICT_TOK_CAPACITY", 60),
  refillPerSec: num("PLUTO_RL_STRICT_TOK_REFILL", 1),
};

function take(key: string, cfg: LimitConfig): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: cfg.capacity, updated: now };
  const elapsed = (now - b.updated) / 1000;
  b.tokens = Math.min(cfg.capacity, b.tokens + elapsed * cfg.refillPerSec);
  b.updated = now;
  if (b.tokens < 1) {
    const wait = Math.ceil((1 - b.tokens) / cfg.refillPerSec);
    buckets.set(key, b);
    return { ok: false, retryAfter: wait };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return { ok: true, retryAfter: 0 };
}

// Periodic GC so we don't leak entries for one-shot IPs.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [k, v] of buckets) if (v.updated < cutoff) buckets.delete(k);
}, 60_000).unref?.();

function tokenKeyFor(req: FastifyRequest): string | null {
  const h = req.headers;
  const raw = (h["apikey"] as string) || (h["authorization"] as string) || "";
  if (!raw) return null;
  return "tok:" + createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export function rateLimit(opts: { ip?: LimitConfig; token?: LimitConfig } = {}) {
  const ipCfg  = opts.ip  ?? DEFAULT_IP;
  const tokCfg = opts.token ?? DEFAULT_TOK;
  return async function preHandler(req: FastifyRequest, reply: FastifyReply) {
    const ipKey = "ip:" + (req.ip || "unknown");
    const ipRes = take(ipKey, ipCfg);
    if (!ipRes.ok) {
      reply.header("retry-after", String(ipRes.retryAfter));
      reply.code(429); return reply.send({ error: "rate_limited", scope: "ip", retry_after: ipRes.retryAfter });
    }
    const tokKey = tokenKeyFor(req);
    if (tokKey) {
      const tokRes = take(tokKey, tokCfg);
      if (!tokRes.ok) {
        reply.header("retry-after", String(tokRes.retryAfter));
        reply.code(429); return reply.send({ error: "rate_limited", scope: "token", retry_after: tokRes.retryAfter });
      }
    }
  };
}

// Preset for expensive routes (AI, edge invoke, backup, restore).
// Both defaults and env overrides are honored via STRICT_IP / STRICT_TOK.
export const strictLimit = rateLimit({ ip: STRICT_IP, token: STRICT_TOK });
