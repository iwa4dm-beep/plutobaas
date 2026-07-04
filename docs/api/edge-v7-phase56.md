# Edge v7 — Phase 56

Enable with `PLUTO_ENABLE_EDGE_V7=1`. Mount prefix `/fn/v7`.
`PLUTO_REGION` (default `local`) tags outbound queue messages.

## Runtime capability scope (through Phase 56)

| Capability | Phase | Status | Auth |
| --- | --- | --- | --- |
| WASM runtime, warm pool, per-region deploy, custom domains | 53 | ✅ | API key |
| Per-function KV, queue triggers, streaming SSE | 53 | ✅ | API key |
| Host imports / outbound https fetch (allowlist + caps) | 55 | ✅ | API key |
| Durable Objects (single-writer actors) | 55 | ✅ | API key |
| Shared KV backplane (versioned LWW, region tiebreaker) | 55 | ✅ | API key |
| **Replicated queues** with dedupe + retry + dead-letter | 56 | ✅ | API key |
| **Cron triggers** with 5-field expressions + misfire grace | 56 | ✅ (admin) | API key + `x-role: admin` for mutation/tick |
| **Signed bindings / secrets injection** (AES-GCM + HMAC) | 56 | ✅ (admin issue) | API key; issue/allowlist require `x-role: admin` |

## Endpoints

### Replicated queues

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/queues/publish` | API key | Publish a message; `id` provides idempotency across regions |
| POST | `/queues/replicate` | API key | Peer-to-peer replay endpoint (called by remote regions) |
| POST | `/queues/poll` | API key | Drain up to `max` messages; simulated dispatcher (real deployments plug the WASM handler) |
| GET  | `/queues/pending?queue=` | API key | Pending count + DLQ size |
| GET  | `/queues/dlq?queue=` | API key | Dead-letter messages after `max_attempts` (5) |

Duplicate suppression is keyed on `(queue, id)`. Retry backoff:
50 ms → 200 ms → 1 s → 5 s → 30 s; after 5 attempts the message moves to the DLQ.

### Cron triggers

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/cron/upsert` | Admin | Create/replace a schedule (`expr`, `module`, `version`, `misfire_grace_ms`) |
| DELETE | `/cron/:id` | Admin | Remove a schedule |
| GET  | `/cron/list` | API key | List schedules |
| POST | `/cron/tick` | Admin | Advance the scheduler and return the fires list |

`expr` is a 5-field cron (`* * * * *`) with `*`, integer, `*/N`, and comma
lists supported. Missed fires older than `misfire_grace_ms` are dropped;
the response reports `misfires_dropped` per schedule.

### Signed bindings

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/bindings/allowlist` | Admin | Set the allowed binding names for a module |
| POST | `/bindings/issue` | Admin | Mint a signed envelope (AES-GCM ciphertext + HMAC signature, TTL ≤ 15 min) |
| POST | `/bindings/verify` | API key | Verify + decrypt on behalf of a module; enforces allowlist, expiry, signature |

Envelope: `{ name, value_b64, exp, sig }`. `sig` = HMAC-SHA256 keyed by
per-workspace master secret over `${name}.${value_b64}.${exp}`. Tampered or
expired envelopes return 403 without leaking the value.

## Streaming behavior

Edge v7 itself does not add new SSE endpoints. Long-poll semantics for queues
are provided via repeated `POST /queues/poll` calls. Streaming replication
status remains on `GET /storage/v4/replication/stream` (Phase 54).

## Notes

- Every mutating cron / binding route enforces `x-role: admin`; non-admin
  callers get HTTP 403 `admin_required`.
- Real production deployments plug the queue dispatcher into the actual
  WASM invocation path; the plugin ships a no-op dispatcher for tests.
- Master secrets for signed bindings default to a per-workspace random key
  on first use; call `setMasterSecret` (or wire an env variable in your
  deployment) to make it stable across restarts.
