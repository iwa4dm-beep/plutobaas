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

## Disaster recovery

We publish the last measured RPO / RTO and restore-correctness result
from our cross-region PITR drill as a durable artifact:

- Latest drill report: [`docs/pitr/latest.md`](./pitr/latest.md)
- Runbook + SLO definitions: [`docs/runbooks/pitr-drill.md`](./runbooks/pitr-drill.md)
- CI job: `backend » cross-region PITR drill` — refreshes the report
  on every merge to `main`, mirrors it into `docs/pitr/latest.md`, and
  uploads the raw markdown as a 90-day workflow artifact.
