# Pluto API — Standardized Error Envelope

All Pluto API endpoints return errors in one consistent JSON envelope. Frontend
clients (dashboard, SDKs, mobile) can rely on this shape without special-casing
individual routes.

## Envelope

```jsonc
{
  "error": "ValidationError",        // machine-readable class
  "message": "name: Required",       // friendly, user-safe summary
  "code": "validation_failed",       // stable code (or Postgres SQLSTATE for DB errors)
  "hint": null,                      // optional operator hint (safe to display)
  "detail": null,                    // optional low-level detail
  "statusCode": 400,                 // mirrors the HTTP status
  "traceId": "cli_9f8e2d13-...-77f0",// correlation ID — echoed on x-request-id header
  "fields": {                        // present on 400 validation errors
    "name": "Required",
    "meta.slug": "Invalid slug"
  }
}
```

Response headers on every request (success or error):

```
x-request-id:     cli_9f8e2d13-...   # same as body.traceId
x-correlation-id: cli_9f8e2d13-...   # duplicate for proxies that filter one
```

## Status → semantics

| Status | `error`             | When                                              | UX                                       |
| ------ | ------------------- | ------------------------------------------------- | ---------------------------------------- |
| 400    | `ValidationError`   | Zod / Fastify schema rejects input                | Show field errors inline via `fields`    |
| 401    | `UnauthorizedError` | Missing / invalid / expired credentials           | Redirect to `/auth`                      |
| 403    | `ForbiddenError`    | Authenticated but not permitted (RLS `42501`)     | Show "no permission" state; don't retry  |
| 404    | `NotFound`          | Resource or route does not exist                  | Empty state / 404 page                   |
| 409    | `DatabaseError`     | Postgres 23505 / 23503 / 40001                    | Ask user to change the value / retry     |
| 413    | `UploadError`       | File / body larger than the allowed maximum       | Show max size in error via `fields.file` |
| 415    | `UploadError`       | Unsupported file MIME type                        | List allowed types                       |
| 422    | `UnprocessableEntity` | Semantic validation                             | Inline field errors                      |
| 429    | `RateLimitError`    | Rate limit tripped                                | Backoff + retry                          |
| 500    | `InternalError`     | Unhandled crash                                   | Show trace ID + Contact Support          |
| 502/503| `UpstreamError`     | Downstream (S3, SMTP, Postgres) unavailable       | Backoff + retry                          |
| 504    | `TimeoutError`      | Operation cancelled by server                     | Retry with smaller batch                 |

## Field-level validation (`fields`)

`fields` is present only on 400 validation errors. Keys are dotted paths that
map directly to your form / request shape:

```jsonc
// POST /admin/v1/projects with { name: "", meta: { slug: "!" } }
{
  "error": "ValidationError",
  "message": "name: String must contain at least 1 character(s)",
  "statusCode": 400,
  "fields": {
    "name": "String must contain at least 1 character(s)",
    "meta.slug": "Invalid slug"
  }
}
```

Client pattern (React Hook Form):

```ts
try {
  await api("/admin/v1/projects", { method: "POST", body: JSON.stringify(values) });
} catch (e) {
  if (e instanceof ApiError && e.status === 400 && e.fields) {
    for (const [path, message] of Object.entries(e.fields)) form.setError(path as any, { message });
    return;
  }
  toast.error(describeError(e).title);
}
```

## Correlation IDs

- The API accepts a caller-supplied ID on `x-request-id`, `x-correlation-id`,
  `x-trace-id`, or W3C `traceparent`. If none is present, one is minted.
- The chosen ID is echoed on `x-request-id` AND `x-correlation-id` response
  headers, and included as `traceId` in the error body.
- The Pluto client SDK auto-mints a `cli_<uuid>` per request and attaches
  both headers. Grep `docker logs api | grep <traceId>` on the VPS to find
  the exact log line.

## OpenAPI reference

The live spec is served at:

- Local dev: `http://localhost:8787/openapi.json` and `/docs`
- Production: `https://api.timescard.cloud/openapi.json` and `/docs`

The shared `ApiError` schema is available at
`#/components/schemas/ApiError`, and every endpoint documents 400/401/403/
404/409/429/500 responses referencing it. Validation-heavy endpoints (POST /
PATCH / PUT) additionally document their request body via the same Zod
schema they use at runtime (see `zodToOpenApi()` +
`standardErrorResponses()` in `src/observability/error-schemas.ts`).

## Recurring-failure alerts

The API observability layer counts failures per `tag` in a 5-minute rolling
window; when a single tag crosses 10 occurrences it logs an `alert=true`
line that external sinks (journald → alertmanager / Loki) can page on:

```json
{"level":50,"alert":true,"tag":"5xx:internal","count":11,"windowMs":300000,"msg":"recurring failure: 5xx:internal (11 in 300000ms)"}
```
