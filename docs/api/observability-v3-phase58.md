# Phase 58 — Observability v3 (distributed traces · live audit tail · SLO alerting)

Enabled with `PLUTO_ENABLE_OBSERVABILITY_V3=1`. Mounted at `/obs/v3`.
Works best in combination with `PLUTO_ENABLE_AUTH_V4=1` so audit-trace
correlation lights up end-to-end.

## Distributed tracing

Every request runs through a global `onRequest` hook that:

1. Parses the incoming W3C `traceparent` header (`version-traceid-spanid-flags`).
   Malformed headers are ignored and a fresh trace id is minted.
2. Starts a span named `<METHOD> <URL>`, attaching `http.method`,
   `http.route`, and `http.status_code` on completion.
3. Echoes a `traceparent` response header so downstream clients can
   continue the trace.

Trace state is exported to a bounded ring buffer (5000 spans) queryable via:

| Endpoint                              | Description                              |
| ------------------------------------- | ---------------------------------------- |
| `GET  /obs/v3/traces?name=&limit=`    | Recent spans, newest first               |
| `GET  /obs/v3/traces/:trace_id`       | All spans for one trace, ordered by start |
| `POST /obs/v3/traces/ingest`          | OTLP-lite ingest: `{ spans: Span[] }`    |

Coverage extends through Auth v4 (`/auth/v4/*`) and Storage v4
(`/storage/v4/*`) because tracing runs at the Fastify layer — no
per-route wiring required.

## Audit ↔ trace correlation

The plugin installs an `authEventContext` provider that returns the
active `trace_id` for the request. Every `logAuth(...)` call auto-attaches
that id. Explicit `trace_id` passed at the call site takes precedence.

Result: an operator viewing an audit row in the dashboard can pivot
directly to the distributed trace via `GET /obs/v3/traces/:trace_id`.

## Live audit tail

`GET /obs/v3/audit/tail?action=&status=` opens a Server-Sent Events
stream scoped to the caller's workspace. Behavior:

- Sends up to 50 recent events on connect, then streams live.
- Filters by `action` and `status` on the server (cheap).
- Heartbeat comment `: hb <ts>` every 15s to keep proxies alive.
- **Backpressure**: an in-memory queue caps at 500 pending events. When
  a slow consumer causes overflow, the oldest event is dropped and a
  synthetic `event: dropped\ndata: { dropped: N }` is emitted so the UI
  can show a "some events were skipped" indicator.

Client sketch:

```js
const es = new EventSource("/obs/v3/audit/tail?action=saml.acs", { withCredentials: true });
es.onmessage = (e) => renderAuditRow(JSON.parse(e.data));
es.addEventListener("dropped", (e) => toast("backpressure: " + JSON.parse(e.data).dropped));
```

## SLO tracking + alerting

Default SLO targets ship for the Auth v4 hot path:

| Endpoint                                | Window | Max error rate | p95 latency |
| --------------------------------------- | ------ | -------------- | ----------- |
| `POST /auth/v4/saml/:slug/acs`          | 60s    | 5%             | 500ms       |
| `POST /auth/v4/scim/v2/Users`           | 60s    | 2%             | 300ms       |
| `PATCH /auth/v4/scim/v2/Users/:id`      | 60s    | 2%             | 300ms       |
| `GET /auth/v4/session/resolve`          | 60s    | 5%             | 150ms       |

Every request records a sample `{ endpoint, latency_ms, ok, trace_id }`.
When the windowed error rate or p95 exceeds the target, an incident is
opened with metadata:

```json
{
  "id": "inc_12_1751...",
  "endpoint": "POST /auth/v4/saml/:slug/acs",
  "breach": "error_rate",
  "error_rate": 0.11,
  "p95_latency_ms": 240,
  "sample_trace_id": "5b8a...c4",
  "opened_at": 1751...,
  "target": { "endpoint": "...", "window_ms": 60000, "max_error_rate": 0.05, "p95_latency_ms": 500 }
}
```

`sample_trace_id` prefers a failing sample so the operator can jump
straight to a broken request. Incidents auto-resolve (`closed_at` set)
once the window drops back inside the target.

| Endpoint                              | Auth              | Notes                             |
| ------------------------------------- | ----------------- | --------------------------------- |
| `GET  /obs/v3/slo/targets`            | apikey            |                                   |
| `POST /obs/v3/slo/targets`            | apikey + `x-role: admin` | Upsert a target                   |
| `GET  /obs/v3/slo/incidents?open=1`   | apikey            | Filter to currently-open incidents |

## Feature flag

Set `PLUTO_ENABLE_OBSERVABILITY_V3=1`. Disabled builds pay zero cost
(no hooks registered, no ring buffer allocated).
