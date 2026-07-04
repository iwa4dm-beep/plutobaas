# API Reference — Tokens & Logs

Base URL: `${PLUTO_URL}` (e.g. `https://pluto.example.com`).
All requests require `apikey: <workspace_publishable_key>`. Endpoints marked
_(bearer)_ additionally require `Authorization: Bearer plt_<prefix>_<secret>`.
Admin endpoints require the caller's session/api-key to have workspace admin
privileges.

Format for workspace API tokens: `plt_<8-hex-prefix>_<url-safe-secret>`.
Only `sha256(plaintext)` is persisted server-side; the plaintext is shown
**once** at creation/rotation and never again.

---

## Tokens

### `GET /tokens/v1/scopes`
Returns the curated scope catalog.

```json
{ "scopes": ["usage:read","usage:write","quotas:read", "..."] }
```

### `GET /tokens/v1/coverage`
Endpoint-level enforcement report — which HTTP routes are gated by each scope.

**Response**
```json
{
  "coverage": {
    "usage:read": [
      { "method": "GET", "path": "/tokens/v1/whoami", "description": "Verify a token and inspect its scopes" },
      { "method": "GET", "path": "/usage/v1/summary", "description": "Workspace usage totals" }
    ],
    "backups:restore": [
      { "method": "POST", "path": "/backups/v1/:id/restore", "description": "Trigger a backup restore" }
    ]
  }
}
```

### `GET /tokens/v1/tokens`
List all tokens for the calling workspace (revoked/expired included; check
`revoked_at` and `expires_at`).

### `POST /tokens/v1/tokens` — admin
Mint a new token. **Plaintext is only returned by this call.**

**Request**
```json
{ "name": "github-actions", "scopes": ["logs:read","usage:read"], "expires_in_days": 90 }
```

**Response `200`**
```json
{
  "id": "b3c9…", "name": "github-actions", "prefix": "a1b2c3d4",
  "scopes": ["logs:read","usage:read"],
  "expires_at": "2026-10-01T00:00:00.000Z",
  "token": "plt_a1b2c3d4_kQ7…"
}
```

**Errors:** `400 bad_body`, `400 unknown_scope { invalid: [...] }`,
`400 workspace_required`.

### `POST /tokens/v1/tokens/:id/rotate` — admin
Clone scopes/expiry of an existing token into a new one; the old token is
revoked in the same transaction. Response mirrors `POST /tokens` with an
extra `replaced_id` field.

**Request (all optional)**
```json
{ "name": "github-actions (rotated 2026-07-04)", "expires_in_days": 90 }
```

**Errors:** `404 not_found`, `409 already_revoked`.

### `DELETE /tokens/v1/tokens/:id` — admin
Revoke a single token. Returns `{ "ok": true }` or `404 not_found`.

### `POST /tokens/v1/tokens/bulk-revoke` — admin
Revoke many tokens by filter. `dry_run: true` returns matches without
mutating. At least one filter field (`scope`, `created_by`,
`last_used_before`, `never_used`, or `ids`) is required.

**Request**
```json
{
  "scope": "logs:read",
  "created_by": "auth0|9f2c…",
  "last_used_before": "2026-06-01T00:00:00Z",
  "never_used": false,
  "include_expired": false,
  "ids": ["b3c9…", "…"],
  "dry_run": true
}
```

**Response**
```json
{
  "dry_run": true,
  "matched": 4,
  "revoked": [],
  "tokens": [
    {
      "id": "b3c9…", "name": "old-ci", "prefix": "a1b2c3d4",
      "scopes": ["logs:read"], "created_by": "auth0|9f2c…",
      "last_used_at": "2026-05-12T10:03:11.000Z",
      "expires_at": null
    }
  ]
}
```

After confirming, resend with `dry_run: false`; `revoked` is populated with
the ids that were revoked in this call.

**Errors:** `400 filter_required`, `400 bad_body`.

### `GET /tokens/v1/whoami` — _bearer, scope `usage:read`_
Echoes the workspace + scopes resolved from the bearer token. Useful for
smoke-testing a freshly minted or rotated token.

```json
{ "workspace_id": "ws_…", "scopes": ["logs:read","usage:read"] }
```

---

## Logs — SSE tail

### `GET /logs/v1/stream`

Server-Sent Events tail of `api_logs`. Each event has an `id:` set to the
row's ISO timestamp so clients can resume via the standard
`Last-Event-ID` header after a reconnect.

**Query params** (all optional)
- `source` — `auth | rest | storage | admin`
- `level` — `info | warn | error`
- `q` — case-insensitive substring match on `message`
- `since` — RFC3339 timestamp (fallback cursor if `Last-Event-ID` is absent)

**Response** (`text/event-stream`)
```
: connected

id: 2026-07-04T10:00:01.123Z
data: {"id":"log_…","ts":"2026-07-04T10:00:01.123Z","source":"rest","level":"info","message":"GET /health 200"}

id: 2026-07-04T10:00:02.887Z
data: {"id":"log_…","ts":"2026-07-04T10:00:02.887Z","source":"auth","level":"warn","message":"invalid credentials"}
```

**Resume after disconnect**
```
GET /logs/v1/stream
apikey: <key>
Last-Event-ID: 2026-07-04T10:00:02.887Z
```
The server emits only rows with `ts > Last-Event-ID`.

Client precedence: `Last-Event-ID` header → `since` query param → server
clock at connect.

---

## Logs — async export

Exports honour the workspace's log-retention window. If `since` predates
the retention floor it is clamped forward and `clamped_since: true` is
returned so the UI can warn.

### `POST /logs/v1/export`

**Request**
```json
{
  "format": "csv",              // or "json"
  "source": "rest",
  "level":  "error",
  "q":      "timeout",
  "since":  "2026-06-01T00:00:00Z",
  "until":  "2026-07-04T00:00:00Z",
  "max_rows": 50000
}
```

**Response**
```json
{
  "job_id": "xj_l9m8…", "status": "queued", "progress": 0,
  "format": "csv",
  "since":  "2026-06-04T00:00:00.000Z",
  "until":  "2026-07-04T00:00:00.000Z",
  "clamped_since": true,
  "keep_days": 30
}
```

### `GET /logs/v1/export/:id`
Poll for progress. Recommended interval: 1s.

```json
{
  "job_id": "xj_l9m8…",
  "status": "running",           // queued | running | done | error
  "progress": 0.42,              // 0..1
  "rows": 21033,
  "format": "csv",
  "error": null,
  "download_url": null           // set when status = "done"
}
```

### `GET /logs/v1/export/:id/download`
Returns the finished export payload with
`Content-Disposition: attachment; filename="logs-<id>.<csv|json>"`.
Jobs are retained in-memory for 15 minutes after completion.

**Errors:** `404 not_found`, `409 not_ready` (job still running or errored).

---

## Common error envelope

Non-2xx responses always return JSON:
```json
{ "error": "insufficient_scope", "required": "logs:read" }
```

| HTTP | `error`               | Meaning                                          |
| ---- | --------------------- | ------------------------------------------------ |
| 400  | `bad_body`            | Zod validation failed; see `issues`              |
| 400  | `bad_query`           | Query params failed validation                   |
| 400  | `workspace_required`  | Caller has no workspace context                  |
| 400  | `filter_required`     | Bulk-revoke called with no filters               |
| 400  | `unknown_scope`       | Scope name not in catalog; see `invalid`         |
| 401  | `unauthenticated`     | Missing/invalid `apikey`                         |
| 403  | `insufficient_scope`  | Bearer token lacks required scope                |
| 403  | `forbidden`           | Caller not a workspace admin                     |
| 404  | `not_found`           | Target token/job doesn't exist in workspace      |
| 409  | `already_revoked`     | Token was already revoked before rotation        |
| 409  | `not_ready`           | Export download requested before job finished    |
