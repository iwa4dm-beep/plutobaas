# Rate limiter — configuration and safe defaults

The Pluto server runs an in-memory leaky-bucket limiter in front of
sensitive routes (auth, billing, admin) and a stricter preset in front
of expensive ones (AI, edge invoke, backups). Two independent buckets
protect every request:

| Bucket | Key format | Purpose |
|---|---|---|
| Per-IP | `ip:<remote>` | Blunts credential stuffing, scrapers, and buggy clients that share a token |
| Per-token | `tok:<sha256(apikey \|\| authorization)>` | Caps a single leaked key even when it rotates IPs |

When either bucket empties, the request rejects with HTTP `429` and
`Retry-After: <seconds>`.

## Configuration

All limits are read at process start from `process.env`. Unset or
non-positive values fall back to the defaults below. Restart the
server after changing.

| Env var | Default | Meaning |
|---|---:|---|
| `PLUTO_RL_IP_CAPACITY`         |  60 | Burst per source IP (tokens) |
| `PLUTO_RL_IP_REFILL`           |   1 | Sustained requests per second per IP |
| `PLUTO_RL_TOKEN_CAPACITY`      | 600 | Burst per API key / bearer token |
| `PLUTO_RL_TOKEN_REFILL`        |  10 | Sustained rps per token |
| `PLUTO_RL_STRICT_IP_CAPACITY`  |  20 | Strict-route burst per IP |
| `PLUTO_RL_STRICT_IP_REFILL`    | 0.3 | ~1 request every 3s per IP on strict routes |
| `PLUTO_RL_STRICT_TOK_CAPACITY` |  60 | Strict-route burst per token |
| `PLUTO_RL_STRICT_TOK_REFILL`   |   1 | Sustained 1 rps per token on strict routes |

## Safe defaults, chosen for beta

* **Per-IP 60 burst / 1 rps** — an interactive dashboard user maxes out
  around 10 rps during a page load; a scraper spamming from one host
  hits the ceiling in about a minute.
* **Per-token 600 burst / 10 rps** — comfortably covers a busy
  application server (~600k requests / day) while a leaked key running
  flat-out is capped at ~864k requests / day.
* **Strict 20 burst / 0.3 rps** — protects revenue-costing paths
  (AI invocations, backup / restore, edge function invokes). One
  buggy loop cannot spend more than a few dollars before it trips.

## Tuning guide

* If legitimate users see 429s from `/dashboard`, raise
  `PLUTO_RL_IP_REFILL` first (not capacity) — capacity only helps for
  short bursts.
* If an integration server sits behind a NAT with many end users, raise
  `PLUTO_RL_IP_CAPACITY` and `PLUTO_RL_IP_REFILL` **on that host's
  outbound IP only** via a load-balancer allow-list, not globally.
* On multi-instance deployments, wire the limiter to Redis via the
  scaling module. The in-memory limiter is per-process — a 3-node
  cluster effectively triples the ceiling.

## Reference

* Implementation: `backend/apps/server/src/lib/ratelimit-mw.ts`
* Tests: `backend/apps/server/src/__tests__/ratelimit.test.ts`
* Global fallback (`@fastify/rate-limit`): configured in `server.ts`
