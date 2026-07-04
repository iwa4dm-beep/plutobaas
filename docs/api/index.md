# Pluto API surface

Every capability the SDK exposes has a stable HTTP contract. Point any
client — curl, Postman, your typed frontend — at the endpoints below.

## Interactive reference

* **Browse in your dashboard:** [`/docs/api`](/docs/api) — renders the
  live OpenAPI spec with try-it-now for every REST endpoint. Auth via
  `apikey` header or bearer token; scopes are minted at
  `/dashboard/tokens`.
* **Raw spec:** `GET /admin/v1/schema/openapi.json` — download and load
  into Postman, Insomnia, or your codegen of choice.

## REST — auto-generated from your schema

Every table in the `public` schema is exposed under `/rest/v1/{table}`
using a PostgREST-compatible filter grammar.

```
GET    /rest/v1/todos?user_id=eq.<uuid>&order=created_at.desc&limit=20
POST   /rest/v1/todos           { "title": "hi" }
PATCH  /rest/v1/todos?id=eq.<uuid>   { "done": true }
DELETE /rest/v1/todos?id=eq.<uuid>
```

Filters: `eq neq gt gte lt lte like ilike is.null in.(a,b,c)`.
Modifiers: `select=`, `order=`, `limit=`, `offset=`.

RLS is enforced by opening a transaction and running
`SET LOCAL pluto.user_id = '<uuid>'` before the query — the same
`current_user_id()` helper your policies use inside migrations.
Service-role callers bypass this and run as the pool user.

Error contract:

| HTTP | `error`             | When                                    |
|------|---------------------|-----------------------------------------|
| 400  | `bad_filter` etc.   | Query string violates the filter grammar |
| 403  | `rls_denied`        | Postgres SQLSTATE `42501`               |
| 404  | `table_not_found`   | Postgres SQLSTATE `42P01`               |
| 409  | `unique_violation`  | Postgres SQLSTATE `23505`               |

## GraphQL — one endpoint, same schema

```
POST /graphql/v1
{ "query": "query { todos(where: { user_id: { eq: $u } }, limit: 5) { id title } }",
  "variables": { "u": "..." } }
```

Fields per table: `insert_<table>`, `update_<table>`, `delete_<table>`.
Filters use the same operators as REST (`eq neq gt gte lt lte like ilike in`).
RLS is applied identically — the resolver opens a transaction and pins
`pluto.user_id` before executing. Errors come back as `{ errors: [{ message }] }`
with HTTP 200, per GraphQL convention.

## Prometheus metrics

`GET /metrics` — text exposition (`text/plain; version=0.0.4`), no auth,
suitable for a scrape target. Enabled by setting
`PLUTO_ENABLE_OBSERVABILITY=1`. Metrics currently exposed:

| Metric                   | Type   | Labels                       | Meaning                                  |
|--------------------------|--------|------------------------------|------------------------------------------|
| `pluto_metric_avg`       | gauge  | `name`                       | Avg of `metrics_samples` over last 5 min |
| `pluto_metric_p95`       | gauge  | `name`                       | p95 of `metrics_samples`                 |
| `pluto_metric_count`     | gauge  | `name`                       | Sample count                             |
| `pluto_queue_jobs`       | gauge  | `status`                     | Jobs by state (`queued`, `running`, …)   |

The `http.request` metric is emitted automatically per request with
`method` and `status` labels — enough to build a request-rate + error-rate
dashboard without instrumenting handlers by hand. Token/auth activity is
attributed by the `x-workspace-id` label ingested on the `/obs/v1/metrics`
POST path.

## Token bulk revocation

Admins can revoke many workspace tokens at once from
**Dashboard → Tokens → Bulk revoke**, or via API:

```
POST /tokens/v1/tokens/bulk-revoke
{ "scope": "logs:read",             // any token carrying this scope
  "created_by": "<user-uuid>",       // and/or minted by this user
  "last_used_before": "2026-01-01T00:00:00Z",
  "never_used": false,
  "dry_run": true }
```

`dry_run: true` returns the matching token set without mutating.
Confirming returns:

```json
{ "dry_run": false, "matched": 12, "revoked": ["<id>", "..."],
  "tokens": [{ "id": "...", "name": "...", "prefix": "...", "scopes": [...] }] }
```

Every bulk action is written to `audit_events` under
`action=tokens.bulk_revoke` with the filter used and the first 100 revoked
ids for traceability.

## Related

* Schema introspection: `GET /rest/v1/introspect`
* OpenAPI (workspace-aware, includes RLS policy hints):
  `GET /admin/v1/schema/openapi.json`
* Realtime + CDC: `docs/api/realtime-cdc.md`
* Edge functions v3: `docs/api/edge-v3.md`
* Billing / PITR: `docs/api/billing-pitr.md`
