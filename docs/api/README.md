# Pluto Backend — Canonical API Contract

**Base URL (local):** `http://localhost:3000`
**Auth header:** `Authorization: Bearer <JWT>` (issued by `/auth/v1/sign-in`)
**Tenant header (optional):** `apikey: <publishable-or-service-key>`

All non-canonical modules (auth_v3, storage_v1..v3, realtime_v1..v4, edge_v1..v6,
data_api_v1..v3, vector_v1..v2, observability_v2, jobs_v1, auth_completion,
auth_phase41) have been archived under `backend/apps/server/src/modules/_archive/`
and are only mounted when the server boots with `PLUTO_ENABLE_LEGACY=1`. Their
migrations remain intact for data safety.

---

## Health & meta

| Method | Path        | Purpose                                    |
| ------ | ----------- | ------------------------------------------ |
| GET    | `/healthz`  | Liveness (process up)                      |
| GET    | `/readyz`   | Readiness (DB, S3, queue reachable)        |
| GET    | `/metrics`  | Prometheus scrape (proxies `/obs/v1/metrics`) |

---

## Auth (canonical: `auth` + `auth_v4`)

Base auth (`/auth/v1/*`):

| Method | Path                        | Purpose                              |
| ------ | --------------------------- | ------------------------------------ |
| POST   | `/auth/v1/sign-up`          | Email + password registration        |
| POST   | `/auth/v1/sign-in`          | Password login → `{access, refresh}` |
| POST   | `/auth/v1/sign-out`         | Revoke current session               |
| POST   | `/auth/v1/refresh`          | Rotate refresh token                 |
| GET    | `/auth/v1/user`             | Current user profile                 |
| GET    | `/auth/v1/oauth/:provider`  | OAuth start                          |
| GET    | `/auth/v1/oauth/callback/:provider` | OAuth callback              |

MFA / SSO addon (`advanced_auth`):

| Method | Path                                | Purpose                    |
| ------ | ----------------------------------- | -------------------------- |
| POST   | `/auth/v1/mfa/enroll`               | Enroll TOTP/WebAuthn       |
| POST   | `/auth/v1/mfa/challenge`            | Start MFA challenge        |
| POST   | `/auth/v1/mfa/challenge/verify`     | Verify challenge           |
| GET    | `/auth/v1/mfa/factors`              | List factors               |
| DELETE | `/auth/v1/mfa/factors/:id`          | Remove factor              |
| POST   | `/auth/v1/sso/:slug/acs`            | SAML ACS (legacy path)     |

Enterprise SAML + SCIM (`auth_v4`):

| Method | Path                                        | Purpose                    |
| ------ | ------------------------------------------- | -------------------------- |
| GET/POST | `/auth/v4/saml/providers`                 | List / create IdP          |
| GET/PUT/DELETE | `/auth/v4/saml/providers/:slug`     | Provider CRUD              |
| POST   | `/auth/v4/saml/:slug/acs`                   | SAML assertion consumer    |
| GET/POST | `/auth/v4/scim/v2/Users`                  | SCIM user provisioning     |
| GET/PUT/PATCH/DELETE | `/auth/v4/scim/v2/Users/:id`  | SCIM user CRUD             |
| GET/POST | `/auth/v4/scim/v2/Groups`                 | SCIM groups                |
| GET    | `/auth/v4/audit/events`                     | Auth audit tail            |

---

## Data API (canonical: `data_api_v4` at `/rest/v4/*`)

| Method | Path                    | Purpose                                          |
| ------ | ----------------------- | ------------------------------------------------ |
| POST   | `/rest/v4/query`        | Typed structured query (filter, order, cursor)   |
| POST   | `/rest/v4/rpc/:name`    | Invoke registered RPC                            |
| GET    | `/rest/v4/rpc`          | List available RPCs + signatures                 |
| GET    | `/rest/v4/stream`       | NDJSON streaming JSON (cursor paginated)         |
| GET    | `/rest/v4/openapi`      | OpenAPI 3 spec for registered tables/RPCs        |

Legacy `/rest/v1`, `/graphql/v1` are gated behind `PLUTO_ENABLE_LEGACY=1`.

---

## Storage (canonical: `storage_v4` at `/storage/v4/*` + `storage_ext` at `/storage/v1/*`)

| Method | Path                                                  | Purpose                        |
| ------ | ----------------------------------------------------- | ------------------------------ |
| POST   | `/storage/v4/objects`                                 | Signed upload / put object     |
| GET    | `/storage/v4/objects/:bucket/:key/versions`           | List object versions           |
| GET    | `/storage/v4/objects/:bucket/:key/versions/:version_id` | Fetch specific version       |
| POST   | `/storage/v4/retention`                               | Set retention lock             |
| POST   | `/storage/v4/replication/submit`                      | Enqueue replication job        |
| GET    | `/storage/v4/replication/status`                      | Replication queue status       |
| GET    | `/storage/v4/replication/stream`                      | SSE stream of replication events |
| POST   | `/storage/v4/replication/run`                         | Force-run replication worker   |

Rendering / resumable uploads (unchanged from v1 surface):

| Method | Path                                        | Purpose               |
| ------ | ------------------------------------------- | --------------------- |
| GET    | `/storage/v1/render/image/:bucket/*`        | On-the-fly transforms |
| POST   | `/storage/v1/render/cache/:bucket`          | Purge transform cache |
| POST   | `/storage/v1/upload/resumable`              | Start resumable upload |
| PUT    | `/storage/v1/upload/resumable/:id`          | Append chunk          |

---

## Realtime (canonical: `realtime_v5` at `/rt/v5/*`)

| Method | Path                            | Purpose                                |
| ------ | ------------------------------- | -------------------------------------- |
| POST   | `/rt/v5/publish`                | Publish message to a room              |
| GET    | `/rt/v5/room/:room/stats`       | Backpressure & queue depth             |
| POST   | `/rt/v5/resume/:id`             | Resume paused subscriber               |
| POST   | `/rt/v5/drain/:id`              | Force-drain subscriber queue           |
| GET    | `/rt/v5/presence`               | Global presence snapshot               |
| GET    | `/rt/v5/presence/:room`         | Per-room presence                      |
| GET    | `/rt/v5/shard-for/:user`        | Resolve user's presence shard          |
| GET    | `/rt/v5/shards`                 | Shard topology                         |
| WS     | `/rt/v5/ws?room=:room&token=...`| WebSocket subscribe (ordered delivery) |

WebSocket frames follow `{seq, ts, room, payload}` (see `docs/api/realtime-v5-phase60.md`).

---

## Edge Functions (canonical: `edge_v7` at `/fn/v7/*`)

| Method | Path                                | Purpose                          |
| ------ | ----------------------------------- | -------------------------------- |
| POST   | `/fn/v7/bindings/issue`             | Issue signed binding token       |
| POST   | `/fn/v7/bindings/verify`            | Verify binding                   |
| GET    | `/fn/v7/bindings/allowlist`         | List allowlisted bindings        |
| GET    | `/fn/v7/cron/list`                  | List cron triggers               |
| POST   | `/fn/v7/cron/upsert`                | Create/update cron               |
| DELETE | `/fn/v7/cron/:id`                   | Delete cron                      |
| POST   | `/fn/v7/cron/tick`                  | Manual tick (test)               |
| GET    | `/fn/v7/queues/dlq`                 | Dead-letter queue                |

---

## Vector (canonical: `vector_v3` at `/vec/v3/*`)

| Method | Path                          | Purpose                                    |
| ------ | ----------------------------- | ------------------------------------------ |
| POST   | `/vec/v3/embeddings/stream`   | Streaming embeddings (NDJSON, backpressure) |
| POST   | `/vec/v3/hybrid/search`       | Lexical + vector hybrid search             |
| GET/PUT | `/vec/v3/hnsw/config`        | Per-tenant HNSW parameters                 |
| POST   | `/vec/v3/hnsw/:index/ddl`     | Apply HNSW index DDL                       |

---

## Jobs (canonical: `jobs_v2` at `/jobs/v2/*`)

| Method | Path                    | Purpose                              |
| ------ | ----------------------- | ------------------------------------ |
| GET/POST | `/jobs/v2/workflows`  | Register / list DAG workflows        |
| POST   | `/jobs/v2/runs`         | Start workflow run                   |
| GET    | `/jobs/v2/runs/:id`     | Run status, per-node result          |

---

## Observability (canonical: `observability_v3` at `/obs/v3/*`; base at `/obs/v1/*`)

| Method | Path                          | Purpose                          |
| ------ | ----------------------------- | -------------------------------- |
| GET    | `/obs/v1/metrics`             | Prometheus text                  |
| POST   | `/obs/v1/metrics/query`       | PromQL-style query               |
| GET    | `/obs/v1/traces`              | Trace search                     |
| GET    | `/obs/v1/traces/:traceId`     | Trace detail                     |
| POST   | `/obs/v3/traces/ingest`       | OTLP-compat ingest               |
| GET    | `/obs/v3/traces/:trace_id`    | v3 trace detail                  |
| GET    | `/obs/v3/audit/tail`          | Live audit stream (SSE)          |
| GET/POST | `/obs/v3/slo/targets`       | SLO target CRUD                  |
| GET    | `/obs/v3/slo/incidents`       | Burn-rate incidents              |

---

## Supporting modules

| Prefix              | Module          | Notes                                     |
| ------------------- | --------------- | ----------------------------------------- |
| `/ai/v1/*`          | ai              | LLM/chat/embeddings via Lovable AI GW     |
| `/billing/v1/*`     | billing         | Plans, checkout, portal, webhooks         |
| `/pitr/v1/*`        | pitr            | Point-in-time recovery                    |
| `/compliance/v1/*`  | compliance      | GDPR export/delete, KMS, residency        |
| `/backups/v1/*`     | backups         | Logical & physical snapshots              |
| `/branches/v1/*`, `/schema/v1/*`, `/usage/v1/*` | branching + usage | DB branches, schema apply, usage alerts |
| `/queue/v1/*`, `/cache/v1/*`, `/admin/v1/rate-limits` | scaling | In-process queue, cache, rate limits |
| `/comms/v1/*`       | comms           | Email / SMS / webhooks                    |
| `/templates/v1/*`   | templates       | Message templates                         |
| `/logs/v1/*`        | logs            | Structured log search + tail              |
| `/tokens/v1/*`      | tokens          | API tokens (scopes, rotation)             |
| `/rt/v2/cdc/*`      | cdc             | Postgres CDC feed                         |
| `/bp/v2/*`          | broadcast_v2    | WS fan-out, ephemeral broadcast           |
| `/devex/v1/*`       | devex           | Plugins, tokens, webhooks (dev)           |
| `/enterprise/v1/*`  | enterprise      | Domains, IP rules, regions, status        |
| `/admin/v1/*`       | admin           | Workspaces, members, SQL runner, schema, integrations, migrations |

---

## Feature flags

Every non-core module gates behind an env flag; when unset, its routes are absent.

```
PLUTO_ENABLE_COMMS=1
PLUTO_ENABLE_ADVANCED_AUTH=1
PLUTO_ENABLE_TEMPLATES=1
PLUTO_ENABLE_AI=1
PLUTO_ENABLE_SCALING=1
PLUTO_ENABLE_OBSERVABILITY=1
PLUTO_ENABLE_DEVEX=1
PLUTO_ENABLE_ENTERPRISE=1
PLUTO_ENABLE_BRANCHING=1
PLUTO_ENABLE_USAGE=1
PLUTO_ENABLE_BACKUPS=1
PLUTO_ENABLE_LEGACY=1   # re-mount 23 archived modules for migration window
```

## Client SDK

See `client/README.md` — a minimal typed TypeScript SDK targeting the
canonical endpoints above. Publishable-key / bearer-token flows only; the
service-role key never leaves the server.
