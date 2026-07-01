# Pluto deployment scripts

All scripts assume you run them from the `backend/` directory:
`./scripts/<name>.sh`.

| script | when to use |
| --- | --- |
| `deploy-local.sh` | Boot the full stack on your laptop for development. Seeds `.env` from `.env.local.example` on first run. Pass `--fresh` to wipe volumes. |
| `deploy-cloud.sh` | First deploy or redeploy to a VPS. Requires a filled-in `.env` (start from `.env.cloud.example`) and DNS pointing `DOMAIN` at the host. |
| `gen-secrets.sh` | Print a fresh set of random secrets. `./scripts/gen-secrets.sh > .env` for a brand-new install. |
| `wait-for-healthy.sh` | Poll `/readyz` until it returns 200. Used by the deploy scripts and any CI job that needs to block until the API is live. |
| `healthcheck.sh` | Single-shot probe (exit 0/1). Wired into the Docker `HEALTHCHECK`. |
| `backup.sh` | `pg_dump` + optional MinIO mirror into `$BACKUP_DIR`. Run from cron. |
| `restore.sh` | Restore a `.sql.gz` dump produced by `backup.sh`. Prompts for confirmation. |

## Endpoints exposed by the API

- `GET /healthz` — always 200 when the process is alive (liveness).
- `GET /readyz`  — 200 only when the DB is reachable and the storage
  driver has loaded (readiness). This is what deploy + Docker health
  checks poll.

## Environment templates

- `.env.local.example` — safe defaults for `docker compose up`.
- `.env.cloud.example` — production template; every value marked
  `REPLACE_WITH_*` must be regenerated before going live.

## Typical flows

Local:
```
cd backend
./scripts/deploy-local.sh
```

Cloud (first deploy):
```
scp -r backend/ user@host:/opt/pluto/
ssh user@host
cd /opt/pluto/backend
./scripts/gen-secrets.sh > .env
$EDITOR .env               # set DOMAIN, ACME_EMAIL, CORS_ORIGIN, SMTP_URL
./scripts/deploy-cloud.sh
```

Cloud (update):
```
git pull && ./scripts/deploy-cloud.sh
```
