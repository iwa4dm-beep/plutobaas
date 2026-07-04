# Realtime v4 — Phase 51

Presence CRDTs, offline event queue, and delta compression for realtime
payloads. Enable with `PLUTO_ENABLE_REALTIME_V4=1`.

## Concepts

- **Hybrid Logical Clock (HLC).** Every presence mutation carries a
  `{ ts, ctr, actor }` tuple. HLC is monotone across wall-clock skew and
  provides a total order used by the CRDT tiebreaker.
- **Presence CRDT.** LWW-Element-Set keyed by HLC — merges are
  commutative, associative, idempotent. Any replica that has seen the
  same set of ops converges to the same live-member view.
- **Offline queue.** Per `(channel, subscriber)` monotonic buffer with
  TTL. On reconnect the client replays with `since_seq=N`; the server
  returns items with strictly increasing `seq`.
- **Delta codec.** Encodes new payloads as `{ set, del }` ops relative
  to a per-topic baseline (RFC 6902-style, top-level object diff).
  Missing baseline ⇒ full snapshot.

## Endpoints

All routes require a valid API key (anon or service_role).

### Presence

```
POST /rt/v4/presence/apply
{ "channel": "room:1", "actor": "u1", "hlc": { "ts": 1730000000000, "ctr": 0, "actor": "u1" },
  "metadata": { "role": "editor" }, "tombstone": false }
→ 200 { ok, changed, size }

POST /rt/v4/presence/merge
{ "channel": "room:1", "entries": [ { "actor": "u1", "hlc": {...}, "metadata": {...} } ] }
→ 200 { ok, size }

GET  /rt/v4/presence/:channel
→ 200 { channel, members: [...], version: [ { actor, hlc } ] }
```

### Offline queue

```
POST /rt/v4/queue/enqueue
{ "channel": "room:1", "subscriber": "s-42", "event": "msg",
  "payload": {...}, "is_delta": true, "base_hash": "...", "ttl_ms": 60000 }
→ 200 { ok, item, queue_size }

GET  /rt/v4/queue/drain?channel=room:1&subscriber=s-42&since_seq=7
→ 200 { channel, subscriber, items: [ { seq, event, payload, is_delta, base_hash } ] }

POST /rt/v4/queue/ack
{ "channel": "room:1", "subscriber": "s-42", "upto_seq": 12 }
→ 200 { ok, removed, remaining }
```

### Delta compression

```
POST /rt/v4/delta/encode
{ "channel": "room:1", "topic": "doc", "payload": {...}, "update_baseline": true }
→ 200 { envelope, encoded_bytes, full_bytes, new_hash }

POST /rt/v4/delta/decode
{ "baseline": {...}, "envelope": { base_hash, ops?, full? } }
→ 200 { ok, payload }
```

## Event contract

`envelope` shape:
```json
{ "base_hash": "abc123",
  "ops": [ { "op": "set", "path": "n", "value": 2 },
           { "op": "del", "path": "tag" } ] }
```
- `full` present ⇒ decoder replaces its baseline entirely.
- `ops` present ⇒ apply top-level object diff to current baseline.
- `base_hash` mismatch ⇒ client should resubscribe to receive a full snapshot.

## Operational notes

- Table storage lives in migration `0049_phase51_realtime_v4.sql`
  (`rt4_presence_state`, `rt4_offline_queue`, `rt4_delta_baseline`).
- The in-process CRDT registry is intended for single-node deployments;
  multi-node fan-out should periodically merge remote snapshots via
  `POST /rt/v4/presence/merge` or over the Phase 43 NATS backplane.
- Delta baselines are per-topic and updated on every encode
  (`update_baseline=false` disables); pair with `hashPayload()` to
  detect divergence between publisher and subscribers.
