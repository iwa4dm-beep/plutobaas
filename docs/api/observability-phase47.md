# Phase 47 — Observability v2

**Status:** Enabled with `PLUTO_ENABLE_OBSERVABILITY_V2=1`.
**Optional OTLP export:** set `PLUTO_OTLP_ENDPOINT=http://collector:4318`.

Adds production-grade observability on top of the Phase 18 basics:

- **OpenTelemetry traces** — W3C `traceparent` propagation, per-request root spans stored as OTLP-shaped rows, and optional forwarding to any OTLP/HTTP collector (Tempo, Honeycomb, Jaeger, Grafana Agent).
- **Structured request logging** — every request emits a structured log line into an in-process ring buffer keyed by route, method, status, and trace id.
- **RED metrics dashboards** — Rate, Errors, and Duration exposed at `/obs/v2/metrics` in Prometheus text format with low-cardinality labels (`{service, route, method, status_class}`).
- **SLO burn-rate alerts** — Google SRE multi-window (5m/1h/6h/24h) evaluation with configurable objectives for availability and latency.
- **Log-based alerts** — Rules match on level + substring + route regex; fire outbound webhooks when the threshold is exceeded within the window.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/obs/v2/traces` | Ingest OTLP-shaped spans (batched, 1–500). |
| GET  | `/obs/v2/traces/:traceId` | Fetch all spans belonging to a trace id. |
| GET  | `/obs/v2/metrics` | Prometheus RED exposition (scrape target). |
| GET  | `/obs/v2/red` | JSON snapshot of RED counters + histograms. |
| POST | `/obs/v2/slos` | Create SLO (admin). |
| GET  | `/obs/v2/slos` | List SLOs. |
| POST | `/obs/v2/slos/:id/evaluate` | Evaluate all burn windows; persists a burn event per window. |
| GET  | `/obs/v2/slos/:id/burn` | Last 200 burn events. |
| POST | `/obs/v2/log-alerts` | Create log alert rule (admin). |
| GET  | `/obs/v2/log-alerts` | List log alert rules. |
| POST | `/obs/v2/log-alerts/tick` | Evaluate all enabled rules and fire webhooks. |
| GET  | `/obs/v2/logs?minutes=10` | Peek recent structured logs. |

## Traceparent propagation

Every response carries `traceparent: 00-<trace>-<span>-01` and `x-trace-id`.
Clients that already include `traceparent` on the request continue the same
trace; otherwise a fresh trace id is minted.

## SLO example

```jsonc
POST /obs/v2/slos
{
  "slug": "api-availability",
  "route_pattern": "^GET /rest/",
  "kind": "availability",
  "objective": 0.999,
  "window_days": 30
}
```

Evaluation returns burn rates alongside the alert threshold:

| Window | Alert burn | Meaning                       |
|--------|-----------:|-------------------------------|
| 5m     | 14.4       | 2% of 30-day budget in 1h     |
| 1h     |  6         | 5% of 30-day budget in 6h     |
| 6h     |  3         | Half of budget in 5 days      |
| 24h    |  1         | Steady-state consumption      |

## Log alert example

```jsonc
POST /obs/v2/log-alerts
{
  "slug": "5xx-spike",
  "level": "error",
  "route_regex": "^/rest/",
  "threshold": 20,
  "window_secs": 300,
  "webhook_url": "https://hooks.slack.com/..."
}
```

Cron the ticker (or call from your scheduler):

```
POST /obs/v2/log-alerts/tick
```

## Migration

`0045_phase47_observability_v2.sql` adds `obs_v2_spans`, `obs_v2_slos`,
`obs_v2_burn_events`, and `obs_v2_log_alerts` with `service_role` policies.
