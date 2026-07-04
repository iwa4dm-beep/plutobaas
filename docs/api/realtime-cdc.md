# Realtime CDC (Change Data Capture) — Phase 33

Signature Supabase-parity feature: turn Postgres row changes into realtime
events subscribers can consume over the existing realtime_v2 websocket
transport.

## Enabling

Server prerequisites:

1. Postgres has logical replication turned on:
   ```
   wal_level = logical
   max_replication_slots >= 4
   ```
2. `wal2json` (or `test_decoding`) output plugin is installed.
3. Set `PLUTO_ENABLE_CDC=1`.

Bootstrap is idempotent — first process wins a `pg_try_advisory_lock` and
creates the publication (`pluto_cdc`) plus slot (`pluto_cdc_slot`).
Others no-op.

## Admin endpoints

All under `/rt/v2/cdc/*`; `apikey` header required; mutations require workspace admin.

### `GET /rt/v2/cdc/tables`
Returns tables enabled for the current workspace (workspace-less rows count as global).
```json
{ "tables": [
  { "schema_name": "public", "table_name": "todos", "enabled": true,
    "created_at": "2026-07-04T…", "updated_at": "2026-07-04T…" }
] }
```

### `POST /rt/v2/cdc/tables` — admin
```json
{ "schema": "public", "table": "todos" }
```
Upserts into `cdc_config` and reconciles the Postgres publication.
Returns `{ ok: true }`.

### `DELETE /rt/v2/cdc/tables/:schema.:table` — admin
Marks the row `enabled=false`; the reconciler drops it from the publication on next boot.

### `GET /rt/v2/cdc/slot-lag`
```json
{ "slot": "pluto_cdc_slot", "lag_bytes": 4194304 }
```
`lag_bytes` is bytes of WAL buffered but not yet consumed. Persistent
non-zero lag means the decoder can't keep up — throttle writes, add
subscribers, or increase `wal_keep_size`.

### `GET /rt/v2/cdc/events`
Query the ring buffer (24h retention). Filter by `schema`, `table`,
`since_id`, `limit` (max 500).

### `POST /rt/v2/cdc/subscribe`
Validation-only — call this before opening a websocket subscription to
catch typos.

**Request**
```json
{ "event": "postgres_changes", "schema": "public", "table": "todos",
  "filter": "user_id=eq.<uuid>" }
```

**Response**
```json
{ "ok": true, "channel": "postgres_changes:public:todos",
  "filter": { "column": "user_id", "op": "eq", "value": "<uuid>" } }
```

## Subscribe grammar

`filter` accepts the PostgREST-style `column=op.value` mini-DSL.
Operators: `eq | neq | gt | gte | lt | lte | in`.
`in` takes a comma list with optional parens: `status=in.(a,b,c)`.

Filter examples:

| Filter | Meaning |
| --- | --- |
| `user_id=eq.b3c9…` | only rows for this user |
| `priority=gte.5` | high-priority rows |
| `status=in.(open,pending)` | open OR pending rows |

Filters run **server-side** against the row emitted by wal2json, so DELETE
events without an OLD image are dropped for any filter that references a
non-PK column (safe default — RLS could bypass otherwise).

## Event payload

Delivered on `postgres_changes:<schema>:<table>` via the existing
websocket. Payload shape:

```json
{
  "channel": "postgres_changes:public:todos",
  "event":   "INSERT",
  "ts":      "2026-07-04T10:15:00.123Z",
  "lsn":     "0/1A2B3C4D",
  "pk":      { "id": "b3c9…" },
  "new":     { "id": "b3c9…", "title": "…", "user_id": "…" },
  "old":     null
}
```

For `UPDATE`, both `new` and `old` are present. `DELETE` sets `old`,
`new: null`.

## Retention & replay

Every dispatched event is also persisted to `public.cdc_events` for 24h.
Consumers can catch up after a socket outage via `GET /rt/v2/cdc/events?since_id=…`.

Sweeper trims the table hourly; adjust `interval '24 hours'` in
`dispatcher.ts::sweepCdcRetention` if you need longer.

## Tuning cheatsheet

| Symptom | Change |
| --- | --- |
| Slot lag growing under write load | Raise `wal_keep_size`; add decoder replicas |
| Missed events after subscriber outage | Replay from `cdc_events` by `since_id` |
| Too many small chunks | Add per-table filters so unrelated writes don't fan out |
| Sensitive columns leaking | Exclude the table via `DELETE /rt/v2/cdc/tables/…` and use manual `pg_notify` instead |
