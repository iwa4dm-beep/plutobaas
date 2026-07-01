# Backup & restore playbook

Pluto ships two scripts: `scripts/backup.sh` (cron-driven) and
`scripts/restore.sh` (operator-driven, verified).

## What gets backed up

- `pg_dump` of the Postgres database (`--clean --if-exists --no-owner`,
  gzip-9). This is the source of truth for auth, RLS policies, tables,
  edge functions, jobs, audit trail, and the migration ledger.
- The object-storage bucket (MinIO or S3) mirrored with `mc mirror`
  when `STORAGE_DRIVER=s3`.
- A `.sha256` sidecar next to every `.sql.gz` so restores can verify
  the archive hasn't rotted on disk.

## Retention

Two buckets live under `$BACKUP_DIR` (default `/var/backups/pluto`):

| bucket   | default keep | cron                         |
| -------- | ------------ | ---------------------------- |
| `daily`  | 14           | `5 3 * * *` (every day 03:05) |
| `weekly` | 12           | `30 3 * * 0` (Sundays 03:30)  |
| `manual` | forever      | run by hand                  |

Override with `BACKUP_RETENTION_DAILY` and `BACKUP_RETENTION_WEEKLY`
in `.env`. Pruning is bucket-scoped, so a weekly snapshot never gets
deleted by the daily rotation.

Install:

```
crontab -e
5 3 * * *   /opt/pluto/backend/scripts/backup.sh daily  >> /var/log/pluto-backup.log 2>&1
30 3 * * 0  /opt/pluto/backend/scripts/backup.sh weekly >> /var/log/pluto-backup.log 2>&1
```

For off-site: rsync `$BACKUP_DIR` to another host or `aws s3 sync` it
to a different provider from the same cron.

## Restore playbook

1. **Pick the dump.** Prefer the newest verified `daily`; fall back to
   `weekly` if a daily is corrupt.
2. **Copy it to the target host** if you're restoring somewhere new.
3. **Run the restore script:**

   ```
   cd /opt/pluto/backend
   ./scripts/restore.sh /var/backups/pluto/daily/pluto-db-20260701T030500Z.sql.gz
   ```

   The script will:
   - `gzip -t` the archive and verify the `.sha256` sidecar.
   - Prompt you to type the DB name before touching anything.
   - Pipe the dump into `psql -v ON_ERROR_STOP=1`.
   - Restart the API container and poll `/readyz`.
   - Print row counts for `users`, `user_roles`, and the migration
     ledger, plus the timestamp of the last applied migration.

4. **Restore object storage** (if the dump is old enough that files
   changed):

   ```
   docker compose -f docker-compose.prod.yml run --rm \
     -v /var/backups/pluto/daily/storage-<STAMP>:/src \
     minio/mc:latest sh -c '
       mc alias set dst $S3_ENDPOINT $S3_ACCESS_KEY $S3_SECRET_KEY &&
       mc mirror --overwrite /src dst/$S3_BUCKET
     '
   ```

5. **Post-restore integrity checks** (already run by `restore.sh`, but
   worth repeating after a disaster restore):

   - `select count(*) from public.users;` — matches source.
   - `select max(applied_at) from public._pluto_migrations;` — recent.
   - Log in as an existing user; JWT signing key hasn't changed so old
     refresh tokens should still verify.
   - Hit `/readyz` externally and confirm status 200.
   - Sample a signed storage URL and download it end-to-end.

6. **Re-enable cron** if you disabled it during the restore.

## Failure modes

| symptom | likely cause | fix |
| --- | --- | --- |
| `corrupt gzip` | disk rot or interrupted write | pick another dump |
| `sha256 mismatch` | file tampered / partial copy | re-copy from the source of truth |
| `psql: ON_ERROR_STOP` | schema drift vs. running app version | roll the app image back to match the dump's era, then restore |
| `/readyz` 503 after restore | migration ledger references files not on disk | redeploy the matching backend image tag |
