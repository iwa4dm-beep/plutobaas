# Realtime v5 — Phase 60

Presence sharding, room-level backpressure, and ordered delivery with
duplicate suppression. Enable with `PLUTO_ENABLE_REALTIME_V5=1`. All
endpoints require an `x-workspace-id` header.

## Capability scope

| Capability                | Endpoint                            | Notes                                                  |
| ------------------------- | ----------------------------------- | ------------------------------------------------------ |
| Upsert presence           | `POST /rt/v5/presence`              | Returns owning `shard`                                 |
| Remove presence           | `DELETE /rt/v5/presence`            |                                                        |
| List room members         | `GET  /rt/v5/presence/:room`        | Aggregates across shards                               |
| Shard stats               | `GET  /rt/v5/shards`                | Per-shard member counts                                |
| Compute shard for user    | `GET  /rt/v5/shard-for/:user`       | Deterministic SHA1 hashing                             |
| Publish ordered message   | `POST /rt/v5/publish`               | Auto-assigns `seq` if omitted; drops duplicate `id`    |
| Subscribe                 | `POST /rt/v5/subscribe`             | `policy`: `drop_oldest` \| `drop_newest` \| `pause`    |
| Unsubscribe               | `DELETE /rt/v5/subscribe/:id`       |                                                        |
| Drain queue               | `GET  /rt/v5/drain/:id?n=100`       | Returns `messages` + `stats`                           |
| Resume paused subscriber  | `POST /rt/v5/resume/:id`            |                                                        |
| Ordered-delivery stats    | `GET  /rt/v5/room/:room/stats`      | `next_expected`, `buffered`, `skipped`                 |

## Presence sharding

Each `(workspace, user_id)` hashes to one of `PLUTO_PRESENCE_SHARDS`
(default 8) shards via SHA-1. Reads aggregate across all shards; writes
land only in the owning shard so hot rooms do not cross-block.

## Ordered delivery

Every message carries `(room, seq, id)`. The delivery buffer holds
out-of-order messages until the head equals `next_expected`. If the head
gap persists past `MAX_HOLD_MS` (500 ms), missing seqs are recorded as
`skipped_seq` and delivery advances so a lost publisher does not stall
the room. Duplicate `id` (or `seq < next_expected`) responses come back
with `dropped_reason: "duplicate"`.

## Backpressure

Each subscriber owns a bounded outbound queue (`max_queue`, default
100). On overflow:

- `drop_oldest` (default): evict head, enqueue new
- `drop_newest`: keep queue, reject new
- `pause`: mark subscriber `paused`; further publishes accumulate the
  `dropped` counter until the client calls `/rt/v5/resume/:id`

`GET /rt/v5/drain/:id` returns queued messages plus subscriber stats
(`queued`, `paused`, `dropped`).

## Event schema

Delivered messages (in `drain.messages`) follow the shared shape:

```json
{
  "room": "chat",
  "seq": 42,
  "id": "m_42_ab12",
  "payload": { ...user payload... },
  "ts": 1751600000000
}
```

Publish request:

```json
POST /rt/v5/publish
{ "room": "chat", "seq": 42, "id": "m_42_ab12", "payload": {"text":"hi"} }
```

Publish response:

```json
{
  "accepted": true,
  "dropped_reason": null,
  "delivered_count": 1,
  "subscribers": { "delivered": 3, "dropped": 0, "paused": 0 },
  "skipped_seq": [],
  "seq": 42
}
```
