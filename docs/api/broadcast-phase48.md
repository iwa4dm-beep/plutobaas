# Phase 48 — Broadcast / Presence v2

WebSocket fan-out, presence sync, and ephemeral broadcasts with configurable
TTL. Enabled with `PLUTO_ENABLE_BROADCAST_V2=1`.

## Storage

- **Redis** (preferred) when `PLUTO_ENABLE_REDIS=1` + `PLUTO_REDIS_URL`. Session
  and presence state live in Redis with per-key `PX` TTL, so any instance can
  read the current online set.
- **Fallback**: in-process map for single-instance deployments; the durable
  tables in `0046_phase48_broadcast_presence.sql` back long-lived state.

Cross-instance fan-out reuses the Phase 43 NATS backplane
(`PLUTO_ENABLE_NATS=1`). When NATS is down, the local bus keeps working and
clients recover missed messages through `/bp/v2/replay`.

## Endpoints

| Method | Path                              | Notes                                     |
|-------:|-----------------------------------|-------------------------------------------|
| WS     | `/bp/v2/ws?channel=&since_seq=`  | Live stream + on-connect replay window    |
| POST   | `/bp/v2/publish`                  | `{ channel, event, payload, ttl_ms? }`    |
| GET    | `/bp/v2/replay/:channel`          | `?since_seq=N` — replay after seq         |
| POST   | `/bp/v2/presence/heartbeat`       | `{ channel, session_id?, state? }`        |
| POST   | `/bp/v2/presence/leave`           | `{ channel, session_id }`                 |
| GET    | `/bp/v2/presence/:channel`        | Snapshot of online members                |
| GET    | `/bp/v2/stats`                    | Bus diagnostics                           |

## Guarantees

- **Ordering**: every publish gets a strictly increasing `seq` per channel.
  All local subscribers observe the same order.
- **Reconnect**: clients pass `since_seq` and receive messages `> since_seq`
  that are still inside their `expires_at` window before switching to live.
- **TTL**: default `PLUTO_BROADCAST_TTL_MS=30_000`, overridable per publish.
  Expired messages are pruned from the replay buffer on the next publish.
- **Presence**: heartbeats refresh a per-session TTL (default 60s). Missing
  a heartbeat evicts the session and emits `presence.leave`.

## End-to-end tests

`src/__tests__/broadcast-v2.test.ts` covers:
- Fan-out ordering across many subscribers.
- Reconnect replay with a `since_seq` cursor.
- TTL eviction from the replay buffer.
- Presence join/leave delta emission.
- Presence consistency under 500 heartbeats across 50 sessions.
