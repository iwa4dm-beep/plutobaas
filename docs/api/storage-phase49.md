# Phase 49 — Storage v3

Signed uploads, resumable multipart at scale, CDN-backed image transform
cache, and per-bucket lifecycle rules. Enabled with
`PLUTO_ENABLE_STORAGE_V3=1`.

## Signed uploads

`POST /storage/v3/uploads/sign` mints an HMAC-signed token bound to a specific
`bucket + object_key + content_type + max_bytes + expires_at`. The client PUTs
bytes to `/storage/v3/uploads/put?token=…`. Tokens are single-use — the
consume ledger (`st3_signed_uploads.consumed_at`) blocks replay.

Configure signing key via `PLUTO_STORAGE_SIGNING_SECRET` (64+ chars in prod).

## Resumable multipart

Sessions are S3-style: `POST /multipart` → many `PUT /:id/parts/:n` →
`POST /:id/complete`. Part PUTs are idempotent — a retry for the same
`part_number` upserts. Completion validates contiguity (1..N) and is itself
idempotent on repeat calls after success.

## Image transform cache

`GET /storage/v3/render/:bucket/*?w=&h=&fit=&quality=&format=` normalizes the
variant, computes a stable `cache_key = sha256(bucket|key|canonical(variant))`,
and 302-redirects to the CDN edge URL (`PLUTO_CDN_BASE_URL`). The DB row is
the origin's cache manifest; the CDN itself absorbs subsequent hits.

TTL is `PLUTO_TRANSFORM_TTL_S` (default 24h).

## Lifecycle rules

Per-bucket rules with actions `expire`, `tier`, or `abort_incomplete`. Create
via `POST /lifecycle/rules`, dry-run via `POST /lifecycle/run/:id`. The
evaluator is a pure function (`lib/lifecycle.ts`) so it is fully unit-tested
and reusable by the background sweeper.

## Tests

`src/__tests__/storage-v3.test.ts` covers signed-token round-trip and
tamper/expiry rejection, image cache normalization/keying, and lifecycle rule
evaluation across prefix / age / tier states.
