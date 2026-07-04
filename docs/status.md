# Service status

Live status: **[/status](/status)** in the dashboard.

## Uptime targets

| Tier | Monthly uptime target |
|---|---|
| Free       | Best-effort |
| Pro        | 99.9% (43m/month allowed downtime) |
| Team       | 99.95% (21m/month) |
| Enterprise | 99.99% custom SLA |

## Regions and health

The `/status` route polls `/healthz` and `/readyz` on every configured
region every 30s and surfaces:

- API reachability
- Database ping + latency
- Object storage reachability
- CDC replication slot lag
- Email queue depth

## Incident policy

1. Detect via alerting rules on `metrics_samples` and `/readyz`.
2. Publish a status page entry within 15 minutes of a P1.
3. Post-mortem within 5 business days for any customer-visible P1/P2.
4. Notify subscribed workspaces via email (see `/dashboard/settings`).

## Historical availability

Rollups live in `metrics_samples` under `metric='http.request'`.
Ninety-day historical uptime is available via
`GET /obs/v1/metrics/query?metric=http.request&window=90d`.
