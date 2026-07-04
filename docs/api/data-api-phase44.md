# Data API v2 — Phase 44

Embedded relations, DB Webhooks, and Foreign Data Wrappers.

## Enable

```
PLUTO_ENABLE_DATA_API_V2=1
```

## Embedded relations — `GET /rest/v2/embed/:table`

PostgREST-style `?select=col,rel(*)` grammar. Foreign keys are auto-discovered from `information_schema`.

```
GET /rest/v2/embed/posts?select=id,title,author(name,email),comments(*)
```

Response:
```json
{ "rows": [
  { "id": 1, "title": "hi", "author": { "name": "…" }, "comments": [ ... ] }
] }
```

- `child_to_parent` FK ⇒ relation attached as **object**.
- `parent_to_child` FK ⇒ relation attached as **array**.
- One batched query per relation (N+0, never per-row).

## DB Webhooks — `/webhooks/v1/*`

| Method | Path                                | Auth  | Purpose                     |
| ------ | ----------------------------------- | ----- | --------------------------- |
| POST   | `/webhooks/v1`                      | admin | create                      |
| GET    | `/webhooks/v1`                      | any   | list                        |
| PATCH  | `/webhooks/v1/:id`                  | admin | update / enable / disable   |
| DELETE | `/webhooks/v1/:id`                  | admin | remove                      |
| POST   | `/webhooks/v1/:id/test`             | admin | enqueue + flush test event  |
| GET    | `/webhooks/v1/:id/deliveries`       | any   | recent delivery log         |
| POST   | `/webhooks/v1/tick`                 | admin | trigger dispatcher sweep    |
| POST   | `/webhooks/v1/emit`                 | svc   | enqueue from triggers/CDC   |

### Signature

Every POST carries:

```
x-pluto-signature: sha256=<HMAC-SHA256(body, webhook.secret)>
x-pluto-event:     INSERT|UPDATE|DELETE
x-pluto-delivery:  <delivery_id>
```

Receivers must verify with a **timing-safe compare** using the same secret returned when the webhook was created.

### Retry policy

Exponential backoff `2^attempt` seconds capped at **5 min**, up to `max_retries` (default 5). After max, delivery is marked `dead`. A background sweeper runs every 5 s.

## Foreign Data Wrappers — `/fdw/v1/*`

Registry for `postgres_fdw` and `file_fdw`. When `apply: true`, the server runs `CREATE EXTENSION`, `CREATE SERVER`, and `CREATE USER MAPPING` for you.

```
POST /fdw/v1/servers
{ "name": "warehouse", "wrapper": "postgres_fdw",
  "options": { "host": "dw.internal", "port": "5432", "dbname": "wh" },
  "user_mapping": { "user": "reader", "password": "***" },
  "apply": true }
```

`/fdw/v1/tables` records foreign-table entries (schema/name mapping + column shape). Actual `IMPORT FOREIGN SCHEMA` or `CREATE FOREIGN TABLE` is left to a DBA runbook so we never fire arbitrary DDL against production without review.

Passwords are redacted (`***`) in `GET /fdw/v1/servers` responses.
