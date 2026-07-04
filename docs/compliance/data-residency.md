# Data residency

Pluto stores workspace data in a single primary region. The region is
selectable per workspace and immutable once data has landed.

## Supported regions

| Region | Location | Primary DB | Object storage |
|---|---|---|---|
| `us-east-1` | Ashburn, VA | Postgres 16 | S3 |
| `us-west-2` | Oregon      | Postgres 16 | S3 |
| `eu-central-1` | Frankfurt | Postgres 16 | S3 |
| `ap-southeast-1` | Singapore | Postgres 16 | S3 |

New regions are added by request.

## Selecting a region

```bash
curl -X POST /compliance/v1/residency \
  -H "apikey: $ANON" -H "authorization: Bearer $TOKEN" \
  -H "x-workspace-id: $WS" \
  -d '{"region": "eu-central-1"}'
```

The workspace admin role is required. The value is persisted in
`public.data_residency`; the routing layer reads it on every request
and refuses cross-region reads unless the caller holds the
`data_residency_bypass` scope.

## Cross-region backup replication

Independent from primary residency. Every base backup and WAL segment
can be mirrored to N regions via `/pitr/v1/replicas` — see
`docs/api/billing-pitr.md`. Replicas are read-only until a restore is
initiated; a replica in a residency-restricted region is only used to
restore to a workspace whose residency matches that region.

## Auditing residency changes

Every change writes an audit row (`kind='residency_change'`) with the
previous region, new region, and requesting user id. Retention: 400 d.
