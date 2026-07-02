# Pluto BaaS — Cloud Deploy Guide

One-command production deploy for a single VPS running Docker.
The exact same `docker compose` stack you tested locally with
`backend/scripts/e2e-local.sh` runs in production behind Caddy for
HTTPS + HTTP/2 termination.

## Prerequisites

- Ubuntu 22.04+ / Debian 12+ VPS with ≥ 2 GB RAM, ≥ 20 GB disk
- Public DNS A/AAAA record for your API domain → the VPS IP
- Docker Engine 24+ (`curl -fsSL https://get.docker.com | sh`)
- Ports **80** and **443** open (Caddy provisions Let's Encrypt certs)

## 1. Bootstrap the host

```bash
ssh root@your-vps
mkdir -p /opt/pluto && cd /opt/pluto
git clone <your-fork> .          # or scp the backend/ folder up
cd backend
cp .env.cloud.example .env
```

## 2. Fill in `.env`

Edit `.env` on the host and set:

| Key                    | What                                                                     |
| ---------------------- | ------------------------------------------------------------------------ |
| `DOMAIN`               | e.g. `api.example.com` (must resolve to this VPS)                        |
| `ACME_EMAIL`           | contact email for Let's Encrypt                                          |
| `POSTGRES_PASSWORD`    | strong random string                                                     |
| `DATABASE_URL`         | `postgres://pluto:<pw>@postgres:5432/pluto`                              |
| `JWT_SECRET`           | 32+ random bytes — `openssl rand -hex 32`                                |
| `ANON_KEY`             | public key clients embed — `pk_anon_$(openssl rand -hex 8)`              |
| `SERVICE_ROLE_KEY`     | admin key kept server-side — `sk_svc_$(openssl rand -hex 16)`            |
| `STORAGE_DRIVER`       | `s3` (recommended) or `local`                                            |
| `S3_ENDPOINT` + creds  | for S3-compatible object storage (AWS, R2, Backblaze, MinIO)             |
| `SMTP_URL`             | for transactional email (magic links, password reset)                    |
| `CORS_ORIGIN`          | comma-separated list of frontend origins allowed to call the API        |

Shortcut: run `bash scripts/gen-secrets.sh` to mint fresh keys and drop
them straight into `.env`.

## 3. Deploy

```bash
cd /opt/pluto/backend
chmod +x scripts/*.sh
./scripts/deploy-cloud.sh
```

`deploy-cloud.sh` does:

1. `docker compose -f docker-compose.prod.yml pull && build`
2. Starts Postgres + Caddy + Pluto in the background.
3. Waits for `/readyz` via `scripts/wait-for-healthy.sh`.
4. Runs pending migrations inside the `pluto` container (dry-run first, then apply — controlled by `MIGRATE_ON_BOOT=1` in `boot.sh`).
5. Prints the final health probe result.

## 4. Verify

```bash
curl -fsS https://$DOMAIN/healthz     # liveness (no DB)
curl -fsS https://$DOMAIN/readyz      # readiness (DB + storage)
```

Point a frontend at it:

```env
VITE_PLUTO_URL=https://api.example.com
VITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxx
```

## 5. Day-2 operations

| Task                            | Command                                              |
| ------------------------------- | ---------------------------------------------------- |
| Nightly backup (retention 30d)  | `crontab -e` → `0 2 * * * /opt/pluto/backend/scripts/backup.sh` |
| Restore from backup             | `./scripts/restore.sh <backup.sql.gz>`               |
| Rolling update                  | `git pull && ./scripts/deploy-cloud.sh`              |
| Live logs                       | `docker compose -f docker-compose.prod.yml logs -f pluto` |
| Rotate service_role key         | edit `.env`, `docker compose up -d pluto`            |
| Storage E2E smoke               | `BASE=https://$DOMAIN bash scripts/e2e-local.sh` (skip `docker compose up`) |

## 6. Auto-deploy on push (optional)

The included `.github/workflows/backend.yml` already contains a `deploy`
job that SSHes into the host and re-runs `deploy-cloud.sh` on every push
to `main`. Add these GitHub Environment secrets to enable it:

```
PLUTO_DOMAIN, PLUTO_ACME_EMAIL,
PLUTO_POSTGRES_PASSWORD, PLUTO_JWT_SECRET,
PLUTO_ANON_KEY, PLUTO_SERVICE_ROLE_KEY,
PLUTO_S3_ACCESS_KEY, PLUTO_S3_SECRET_KEY,
PLUTO_SMTP_URL, PLUTO_CORS_ORIGIN,
DEPLOY_HOST, DEPLOY_USER, DEPLOY_SSH_KEY
```

## Managed alternatives

If you don't want to run Docker yourself:

| Component  | Managed option                                                     |
| ---------- | ------------------------------------------------------------------ |
| Postgres   | Neon / Supabase-hosted PG / AWS RDS / DigitalOcean Managed DB      |
| Storage    | AWS S3 / Cloudflare R2 / Backblaze B2 (all S3-compatible)          |
| App server | Fly.io / Railway / Render — use the same `Dockerfile` under `apps/server` |
| SMTP       | Resend / Postmark / Amazon SES                                     |

Point `DATABASE_URL`, `S3_*`, and `SMTP_URL` at these managed services in `.env`, keep `STORAGE_DRIVER=s3`, and skip the `postgres` + `minio` services from `docker-compose.prod.yml`.

---

## 7. Storage module — local vs cloud configuration

Pluto's Storage module ships two drivers behind the same REST surface
(`/storage/v1/*`). Pick one at deploy time via `STORAGE_DRIVER`; the
frontend SDK and RLS rules are identical either way.

### 7.1 Local driver (single-host, fastest to boot)

Best for: dev, staging, small self-hosted installs, air-gapped setups.

`.env` on the host:

```env
STORAGE_DRIVER=local
STORAGE_LOCAL_DIR=/var/lib/pluto/storage    # host path, mounted into the container
STORAGE_MAX_UPLOAD_MB=100                   # per-request cap; buckets can override
STORAGE_SIGNED_URL_TTL_MAX=3600             # seconds; clamps `expires_in`
```

`docker-compose.prod.yml` — mount a persistent volume so objects
survive container restarts:

```yaml
services:
  pluto:
    volumes:
      - pluto_storage:/var/lib/pluto/storage
volumes:
  pluto_storage:
```

Back it up nightly (already covered by `scripts/backup.sh` when
`BACKUP_STORAGE_DIR=/var/lib/pluto/storage` is set in `.env`).

### 7.2 Cloud driver (S3 / R2 / B2 / MinIO)

Best for: production, multi-node, geo-distributed, unlimited scale.

`.env` on the host:

```env
STORAGE_DRIVER=s3
S3_ENDPOINT=https://s3.us-east-1.amazonaws.com   # or https://<accountid>.r2.cloudflarestorage.com
S3_REGION=us-east-1
S3_BUCKET=pluto-prod                              # single physical bucket; Pluto buckets map to key prefixes
S3_ACCESS_KEY=AKIA...
S3_SECRET_KEY=****
S3_FORCE_PATH_STYLE=true                          # true for MinIO/R2, false for AWS virtual-hosted style
STORAGE_SIGNED_URL_TTL_MAX=3600
```

Provider quick-notes:

| Provider          | `S3_ENDPOINT`                                        | Notes                                              |
| ----------------- | ---------------------------------------------------- | -------------------------------------------------- |
| AWS S3            | `https://s3.<region>.amazonaws.com`                  | `S3_FORCE_PATH_STYLE=false`                        |
| Cloudflare R2     | `https://<accountid>.r2.cloudflarestorage.com`       | free egress; `S3_FORCE_PATH_STYLE=true`            |
| Backblaze B2      | `https://s3.<region>.backblazeb2.com`                | cheapest cold storage                              |
| MinIO (self-host) | `http://minio:9000` (compose)                        | see optional `minio` service in `docker-compose.prod.yml` |

Bucket CORS (browser uploads/downloads via signed URLs):

```json
[{
  "AllowedOrigins": ["https://your-frontend.example.com"],
  "AllowedMethods": ["GET", "PUT", "HEAD"],
  "AllowedHeaders": ["*"],
  "ExposeHeaders": ["ETag"],
  "MaxAgeSeconds": 3000
}]
```

### 7.3 Compose services touched by Storage

- `pluto` — always. Reads `STORAGE_DRIVER` and dispatches to the right driver.
- `postgres` — always. Stores `storage_buckets`, `storage_objects`,
  `storage_signed_grants`, `storage_uploads`, and RLS policies.
- `minio` — **optional**, only when self-hosting object storage. Leave
  the `minio` service commented out in `docker-compose.prod.yml` when
  using AWS/R2/B2, and remove the `pluto_storage` volume when using
  `STORAGE_DRIVER=s3`.

### 7.4 Verify Storage end-to-end after deploy

Run the storage matrix against the live host — it exercises bucket
CRUD, RLS, multipart uploads, signed URL revocation, one-time signed
URLs, and cross-workspace isolation:

```bash
export BASE="https://$DOMAIN"
export ANON_KEY="$(grep ^ANON_KEY .env | cut -d= -f2)"
export SERVICE_ROLE_KEY="$(grep ^SERVICE_ROLE_KEY .env | cut -d= -f2)"
export DATABASE_URL="$(grep ^DATABASE_URL .env | cut -d= -f2)"
export JWT_SECRET="$(grep ^JWT_SECRET .env | cut -d= -f2)"

# skip the "start server" section — point at the deployed host instead:
PLUTO_BASE_URL="$BASE" bash scripts/e2e-storage-ci.sh
```

Expected final line:

```
✅ Storage CI E2E: signed URLs + multipart + negative RLS all green
```

Any non-zero exit means a bucket policy, signed-URL grant, or
workspace-isolation check regressed and the deploy should be rolled
back with `git checkout <last-good-sha> && ./scripts/deploy-cloud.sh`.

