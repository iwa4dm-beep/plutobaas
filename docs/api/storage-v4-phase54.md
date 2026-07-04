# Storage v4 — Phase 54

Adds object versioning, immutable retention (governance/compliance + legal
hold), and cross-region replication with retry/backoff, checksum verification,
idempotency keys, and monotone per-object ordering. Enable with
`PLUTO_ENABLE_STORAGE_V4=1`.

## Endpoints (mount prefix `/storage/v4`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/objects` | Upload a new version (`bucket`, `object_key`, `body_base64`) |
| GET  | `/objects/:bucket/:key/versions` | List all versions (newest first) |
| GET  | `/objects/:bucket/:key/versions/:version_id` | Fetch a specific version |
| DELETE | `/objects/:bucket/:key/versions/:version_id` | Delete a version; add delete-marker. Header `x-retention-bypass: governance` overrides governance locks. |
| POST | `/retention` | Set/extend a lock (`mode`, `retain_until`, `legal_hold`) |
| POST | `/retention/legal-hold/clear` | Clear legal hold |
| POST | `/replication/submit` | Schedule a cross-region copy job with `idempotency_key` |
| POST | `/replication/run` | Drive one attempt of a job (checksum-verified) |
| GET  | `/replication/status` | Job status per `(bucket, object_key, version_id)` |

## Retention semantics

- **governance** — modification/deletion is blocked while `retain_until` is in
  the future, but callers holding `x-retention-bypass: governance` can override.
- **compliance** — the lock cannot be shortened, downgraded, or bypassed until
  `retain_until` passes.
- **legal_hold** — takes precedence over `retain_until`; must be explicitly
  cleared via `/retention/legal-hold/clear`.

## Replication conflict resolution

- **Idempotency**: `submit` is keyed on `idempotency_key`; duplicate calls
  return the same job id.
- **Ordering**: a per-`(target_region, bucket, object_key)` cursor stores the
  last replicated `${created_at}::${version_id}`. Older versions submitted
  after a newer one has replicated are `skipped`.
- **Retry + backoff**: 50 ms → 200 ms → 1 s → 5 s → 30 s; after 5 failed
  attempts a job transitions to `failed`.
- **Checksum verification**: `remote_checksum` must equal the source
  `checksum_sha256`; mismatch triggers a retry with the current backoff.

## Data model

Migration `0052_phase54_storage_v4.sql` adds `storage4_object_versions`,
`storage4_retention_locks`, `storage4_replication_jobs`, all workspace-scoped
with RLS via `public.current_workspace_id()`.
