# Cross-region PITR failover drill

This runbook simulates losing the primary region and recovering onto a
DR replica. Run it on a schedule (monthly) to catch drift between the
documented RPO/RTO and the actual behavior.

**Target SLO** (adjust to your commitment):

| Metric | Target | Meaning                                        |
|--------|--------|------------------------------------------------|
| RPO    | ≤ 60 s | Max data loss window at failover               |
| RTO    | ≤ 15 m | Time from failover decision to first-byte read |

## Prerequisites

1. Lovable Cloud → **Advanced → PITR** is enabled
   (`PLUTO_ENABLE_PITR=1`, `wal_archive_config.enabled = true`).
2. At least one `backup_replicas` row for the DR region with
   `status = 'ok'` (see `POST /pitr/v1/replicas`).
3. `SERVICE_ROLE_KEY` for the target project.
4. `jq` and `curl` on the operator machine.

## Executing the drill

```bash
export BASE_URL=https://project--<id>.lovable.app
export SERVICE_ROLE_KEY=sk_...
# Optional — defaults to "5 minutes ago"
export TARGET_TIME=2026-07-04T10:00:00Z
./backend/scripts/pitr-drill.sh
```

The script:

1. Verifies WAL archiving is on.
2. Requests a **dry-run** restore for `TARGET_TIME` — this validates that
   we have a base backup on or before the target plus the WAL segments to
   replay up to it, without touching a live cluster.
3. Polls `GET /pitr/v1/restore/:id` until `status ∈ {done, failed}`.
4. Lists cross-region replicas and prints their `replicated_at` /
   `verified_at` timestamps.
5. Prints an RPO/RTO summary.

## Interpreting the summary

| Value        | Source                                                     |
|--------------|------------------------------------------------------------|
| `RTO (sec)`  | Wall-clock from restore request to `status=done`           |
| `RPO (sec)`  | `target_time − wal_archive_config.last_archived_at`        |

If either exceeds the SLO, open an incident and:

* **High RTO** — check `pitr_restores.error`, WAL storage read throughput,
  and the DR machine size.
* **High RPO** — check the archiver process (`pg_receivewal`) on the
  primary, network egress limits, and DR bucket write availability.

## Real (non-drill) failover

Rerun with `dry_run: false` in the restore payload — the control plane
records the intent, then the out-of-process runner performs
`pg_basebackup` restore + WAL replay against the DR primary and flips
DNS via the provider. Follow up by:

1. Re-issuing service-role and JWT signing keys
   (`POST /kms/v1/rotate`, see `docs/compliance/kms.md`).
2. Pointing all edge-function deployments at the new region
   (`POST /fn/v3/deployments/:id/rollback` for any that pinned host allow-lists).
3. Recording the incident and RPO/RTO actuals in the compliance log
   (`compliance_events`, `residency_ledger`).

## Related

* Control plane: `backend/apps/server/src/modules/pitr/plugin.ts`
* Schema: `backend/apps/server/src/db/migrations/0036_pitr.sql`
* API reference: `docs/api/billing-pitr.md`
