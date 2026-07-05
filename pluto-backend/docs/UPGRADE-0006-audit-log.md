# Upgrade Guide — 0006_governance audit_log fix

This guide upgrades an existing Pluto database whose `admin.audit_log` table
predates the idempotent `0006_governance.sql` (missing `project_id`,
`resource_type`, `params`, `result`, FK, or indexes).

## 0. Backup first

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec postgres \
  pg_dump -U pluto -d pluto -Fc -f /tmp/pre-0006-upgrade.dump
docker compose --env-file .env -f docker/docker-compose.yml \
  cp postgres:/tmp/pre-0006-upgrade.dump ./pre-0006-upgrade.dump
```

## 1. Diagnose current state

```bash
curl -s http://127.0.0.1:3000/health/migrations | jq
# or, from inside the api container:
docker compose --env-file .env -f docker/docker-compose.yml exec api \
  node packages/api/scripts/validate-audit-schema.mjs
```

The validator prints exactly which columns / FK / indexes are missing.

## 2. Reset the failed migration marker (if 0006 half-applied)

If `_pluto_migrations` already contains `0006_governance.sql` from a broken run,
remove it so the fixed version re-runs:

```sql
delete from _pluto_migrations where name = '0006_governance.sql';
```

The migration is written to be idempotent (`add column if not exists`,
`create index if not exists`, guarded FK creation), so re-running it is safe.

## 3. Run the fixed migration

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec api \
  node packages/api/scripts/migrate.mjs
```

What it does, in order:
1. `ALTER TABLE admin.audit_log ADD COLUMN IF NOT EXISTS …` for every new column
   (`project_id`, `resource_type`, `resource_id`, `params`, `result`,
   `duration_ms`, `error_message`).
2. Backfills sensible defaults into legacy rows
   (`resource_type := 'unknown'`, `params := '{}'::jsonb`, `result := 'ok'`).
3. `ALTER … SET DEFAULT` + `SET NOT NULL` on the three critical columns.
4. Adds `audit_log_project_fk` FK to `admin.projects(id)` only if it does not
   already exist.
5. Creates indexes: `audit_log_created_at_idx`, `audit_log_project_idx`,
   `audit_log_actor_idx`, `audit_log_action_idx`, `audit_log_params_gin`.

## 4. Verify

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec api \
  node packages/api/scripts/validate-audit-schema.mjs
curl -s http://127.0.0.1:3000/health/migrations | jq '.status, .audit_log_columns, .audit_log_fk, .audit_log_indexes'
```

Both should report `ok: true`. Then confirm sealing still works:

```bash
TOKEN=… # admin JWT
curl -s -H "authorization: bearer $TOKEN" \
  http://127.0.0.1:3000/admin/v1/audit-seals | jq
curl -s -X POST -H "authorization: bearer $TOKEN" \
  http://127.0.0.1:3000/admin/v1/audit-seals | jq
curl -s -H "authorization: bearer $TOKEN" \
  http://127.0.0.1:3000/admin/v1/audit-seals/verify | jq
```

## 5. Rollback (only if step 3 fails badly)

```bash
docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres \
  pg_restore -U pluto -d pluto --clean --if-exists < pre-0006-upgrade.dump
```

## Notes

- Legacy rows keep their original `target` / `metadata` / `ip` columns; the new
  writer path (`packages/api/src/audit/logger.ts`) writes both old and new
  columns so historical queries still work.
- If your project uses `public.audit_log` instead of `admin.audit_log`, apply
  the same `ALTER`s against that schema; the schema-qualified migration will
  not touch `public`.
