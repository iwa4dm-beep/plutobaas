# Edge v6 — Phase 55

Enable with `PLUTO_ENABLE_EDGE_V6=1`. All routes require an API key.
Mount prefix `/fn/v6`.

## Runtime capability scope (Phase 55)

| Capability | Status | Details |
| --- | --- | --- |
| WASM runtime | ✅ (Phase 53) | Module registry, warm pool, per-region deploy |
| Per-function KV (local) | ✅ (Phase 53) | Process-local, TTL, prefix list |
| Queue triggers | ✅ (Phase 53) | Bind subscribers, drain FIFO, re-queue on failure |
| Streaming response | ✅ (Phase 53) | SSE via `/fn/v5/stream` |
| **Host imports / outbound fetch** | ✅ (Phase 55) | Per-workspace https allowlist, method/scheme/size caps, 30 s max timeout |
| **Durable Objects** | ✅ (Phase 55) | `(class, id)`-keyed actors, single-writer serialization, built-in `counter` class |
| **Shared KV backplane** | ✅ (Phase 55) | Versioned LWW, region tiebreaker, injectable peer transport |
| Replicated queues (multi-region) | ⏳ Phase 56 | Planned |
| Cron triggers | ⏳ Phase 56 | Planned |
| Signed bindings (secrets injection) | ⏳ Phase 56 | Planned |

## Endpoint index

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/host-fetch/allow` | Set the workspace's outbound https allowlist (up to 50 hosts) |
| POST | `/host-fetch` | Proxy an https request from a WASM handler; body is base64 |
| POST | `/do/:class/:id/call` | Call a Durable Object method (`method`, `args`) |
| GET  | `/do/:class/:id` | Inspect DO state |
| POST | `/kv/put` | Backplane put — versioned, fans out to peers |
| GET  | `/kv/get` | Backplane get — returns `{value, version, updated_at, region}` |
| DELETE | `/kv` | Backplane delete |
| POST | `/kv/replicate` | Apply a remote LWW op received from a peer |
| GET  | `/kv/keys` | List backplane keys by prefix |

## Host fetch guarantees

- `https:` only; non-`https` schemes rejected with `scheme_forbidden`.
- Hostname must match the workspace allowlist (exact host or any `.suffix`).
- Response body capped at 5 MiB.
- Default 5 s timeout (configurable up to 30 s).
- `host` and `content-length` are always stripped from caller-supplied headers.

## Durable Object semantics

- Every `callDo(cls, id, call)` for the same `(cls, id)` is serialized —
  concurrent calls run one after another so counters/state are race-free.
- Handlers return `{ state, result }`; the store persists `state` and returns
  `result` to the caller.
- Built-in `counter` class supports `inc` / `get` / `reset`. Register new
  classes with `registerClass(cls, handler)`.

## Shared KV backplane

- Every `bpPut` increments the entry's `version` and fans out to registered
  transports.
- Remote ops resolve conflicts via **Last-Writer-Wins**: higher `version`
  wins; ties broken by lexicographically-smaller `region`.
- Peers receive ops through `/fn/v6/kv/replicate`.

## Streaming replication status (Phase 54 addition)

`GET /storage/v4/replication/stream?bucket=…&object_key=…&version_id=…`
returns `text/event-stream` frames every 250 ms. Each frame is a
`data: { ts, jobs: [...] }` JSON payload. The stream ends when every job for
that version reaches a terminal state (`succeeded`, `failed`, `skipped`) or
`max_events` (default 60) is reached.
