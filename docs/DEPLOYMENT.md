# Pluto BaaS — Deployment Guide

One canonical guide covering: **Docker audit**, **local**, **Fly.io**,
**Railway**, **Render**, and **self-hosted VPS**. Pick one path — all use
the same `apps/server/Dockerfile`.

---

## 0. Dockerfile audit (what changed and why)

`backend/apps/server/Dockerfile` was rewritten with four fixes over the
original single-stage build:

| # | Issue in old file | Fix |
|---|---|---|
| 1 | `npm install` without lockfile — non-reproducible | `npm ci` against `package-lock.json` |
| 2 | Runtime image shipped **devDependencies** (`tsx`, `tsc`, `vitest`) → ~450 MB | Dedicated `prod-deps` stage with `--omit=dev` → ~180 MB |
| 3 | No PID 1 signal handler — `SIGTERM` was ignored, k8s/Fly killed after 10s | `tini` as `ENTRYPOINT` for clean graceful shutdown |
| 4 | Missing native-build toolchain for `argon2` on alpine | `python3 make g++ libc6-compat` added to `deps` + `prod-deps` |
| 5 | No `.dockerignore` — `node_modules`, `.env`, tests copied into context | New `.dockerignore` |

Verify locally:

```bash
cd backend/apps/server
docker build -t pluto/server:latest .
docker run --rm -p 3000:3000 --env-file ../../.env pluto/server:latest
curl -fsS http://localhost:3000/readyz
```

Image size should be ≤ 200 MB.

---

## 1. Required env vars (all deploys)

| Var | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✓ | `postgres://user:pw@host:5432/db?sslmode=require` |
| `JWT_SECRET` | ✓ | `openssl rand -hex 32` |
| `ANON_KEY` | ✓ | Public — frontends embed this. `pk_anon_$(openssl rand -hex 8)` |
| `SERVICE_ROLE_KEY` | ✓ | **Server-only.** Never ship to browser. `sk_svc_$(openssl rand -hex 16)` |
| `STORAGE_DRIVER` |   | `s3` (recommended) or `local` |
| `S3_ENDPOINT` | s3 | e.g. `https://<acct>.r2.cloudflarestorage.com` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | s3 |   |
| `S3_BUCKET` | s3 | Single physical bucket; Pluto buckets → key prefixes |
| `S3_REGION` |   | Default `us-east-1` (use `auto` for R2) |
| `S3_FORCE_PATH_STYLE` |   | `true` for R2/MinIO, `false` for AWS |
| `SMTP_URL` |   | Skip → no outgoing mail |
| `CORS_ORIGIN` |   | Comma-separated frontend origins |
| `PLUTO_ENABLE_OBSERVABILITY` |   | `1` for `/metrics` scrape target |
| `PLUTO_ENABLE_LEGACY` |   | `0` (default). Set `1` only during v3→v4 migration |

Generate all secrets at once: `bash backend/scripts/gen-secrets.sh > .env`.

---

## 2. Local (Docker Compose)

```bash
cd backend
docker compose up -d db minio
./scripts/smoke-boot.sh          # migrate → boot → poll /readyz
```

Expected: `readyz OK (200)` and `{"ok":true,"db":true,"storage":true}`.

Frontend `.env`:
```
VITE_PLUTO_URL=http://localhost:3000
VITE_PLUTO_ANON_KEY=dev-anon-key
```

Open the dashboard SDK demo: `/dashboard/sdk-demo`.

---

## 3. Fly.io (recommended for global edge)

**Prereqs**: `fly` CLI, a Fly account.

```bash
cd backend
cp deploy/fly.toml fly.toml      # copy to repo root of the deploy
fly launch --no-deploy --copy-config

# Managed Postgres (auto-injects DATABASE_URL as a secret)
fly postgres create --name pluto-db --region iad --initial-cluster-size 1
fly postgres attach pluto-db

# Object storage — use Cloudflare R2 (free egress) or Tigris
fly secrets set \
  JWT_SECRET="$(openssl rand -hex 32)" \
  ANON_KEY="pk_anon_$(openssl rand -hex 8)" \
  SERVICE_ROLE_KEY="sk_svc_$(openssl rand -hex 16)" \
  S3_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com" \
  S3_ACCESS_KEY="..." S3_SECRET_KEY="..." \
  S3_BUCKET="pluto-prod" S3_REGION="auto" S3_FORCE_PATH_STYLE="true" \
  CORS_ORIGIN="https://your-frontend.example.com"

fly deploy
fly status
curl -fsS https://pluto-server.fly.dev/readyz
```

`fly.toml` runs `node dist/db/migrate.js` on every deploy as
`release_command`, so migrations ship automatically.

**Scale**:
- `fly scale count 2` — HA
- `fly scale vm shared-cpu-2x --memory 1024` — bigger machine
- `fly autoscale set min=1 max=5` — auto

---

## 4. Railway (fastest 1-click)

**Prereqs**: Railway account, GitHub repo pushed.

1. **New Project → Deploy from GitHub Repo** → pick this repo.
2. Root directory: `backend`. Config: it auto-detects `deploy/railway.json`.
3. **Add Plugin → PostgreSQL**. `DATABASE_URL` is injected automatically as `${{Postgres.DATABASE_URL}}` — reference it in the service **Variables** tab.
4. Add remaining vars in **Variables** tab (same list as §1).
5. Object storage: Railway doesn't have S3. Use **Cloudflare R2** (free 10 GB, free egress) or AWS S3.
6. **Deploy**. Public URL is at **Settings → Networking → Generate Domain**.

Migrations run at container boot via `boot.sh` (`MIGRATE_ON_BOOT=1`).

---

## 5. Render.com (simplest managed Postgres bundle)

Push the repo, then in Render dashboard:

1. **New → Blueprint** → point at `backend/deploy/render.yaml`.
2. Render provisions Postgres + web service in one shot.
3. Fill in `sync: false` secrets (S3 credentials, `ANON_KEY`, `SERVICE_ROLE_KEY`) in the dashboard.
4. **Manual Deploy → Deploy latest commit**.

Auto-scaling: **Settings → Scaling**. Backups: **Postgres → Backups** (daily on paid plans).

---

## 6. Self-hosted VPS (full control, cheapest)

Already covered in `backend/CLOUD_DEPLOY.md`. Short version:

```bash
ssh root@your-vps
curl -fsSL https://get.docker.com | sh
git clone <your-fork> /opt/pluto && cd /opt/pluto/backend
cp .env.cloud.example .env && $EDITOR .env
./scripts/deploy-cloud.sh
```

Caddy handles TLS via Let's Encrypt.

---

## 7. Managed Postgres options

| Provider | Free tier | Best for |
|---|---|---|
| **Neon** | 0.5 GB / branching | Serverless, scale-to-zero |
| **Supabase** | 500 MB | If you already use Supabase auth |
| **Fly Postgres** | pay-as-you-go | Same-region as Fly app |
| **Railway PG** | $5/mo | Bundled with Railway app |
| **Render PG** | 90-day free | Bundled with Render app |
| **RDS / Aurora** | none | Enterprise |

**Required extensions** (Pluto migrations run these automatically):
- `pgcrypto` (all managed providers)
- `uuid-ossp` (all)
- `vector` for Vector v3 (Neon ✓, Supabase ✓, Fly ✓, RDS via extension, Railway ✗ — skip Vector on Railway)
- `pg_cron` optional for scheduled jobs (Supabase ✓, others via workaround)

---

## 8. Object storage options

| Provider | Egress | Endpoint |
|---|---|---|
| **Cloudflare R2** | **free** | `https://<acct>.r2.cloudflarestorage.com` |
| **Backblaze B2** | free ≤ 3× storage | `https://s3.<region>.backblazeb2.com` |
| **AWS S3** | $0.09/GB | `https://s3.<region>.amazonaws.com` |
| **Tigris** (Fly) | free in-region | `https://fly.storage.tigris.dev` |
| **MinIO** self-host | free | your box |

R2 is the default recommendation for cost.

---

## 9. Post-deploy verification checklist

```bash
BASE="https://your-api.example.com"

# 1. Liveness + readiness
curl -fsS $BASE/healthz
curl -fsS $BASE/readyz

# 2. Auth roundtrip
curl -fsS -X POST $BASE/auth/v1/sign-up \
  -H "apikey: $ANON_KEY" -H "content-type: application/json" \
  -d '{"email":"test@example.com","password":"testpass1234"}'

# 3. Storage bucket create (admin)
curl -fsS -X POST $BASE/storage/v4/buckets \
  -H "apikey: $SERVICE_ROLE_KEY" -H "content-type: application/json" \
  -d '{"name":"public","public":true}'

# 4. Metrics scrape (if PLUTO_ENABLE_OBSERVABILITY=1)
curl -fsS $BASE/metrics | head
```

All four should return 2xx. If `/readyz` returns 503, check container logs
for `DATABASE_URL` connectivity or missing extensions.

---

## 10. Connect the frontend

In your React app:

```env
# .env
VITE_PLUTO_URL=https://your-api.example.com
VITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxx
```

```ts
import { createClient } from "@pluto/client";

export const pluto = createClient({
  baseUrl: import.meta.env.VITE_PLUTO_URL,
  apikey:  import.meta.env.VITE_PLUTO_ANON_KEY,
});

await pluto.auth.signIn(email, password);
const { rows } = await pluto.data.query({ table: "posts", limit: 20 });
```

The bundled dashboard **`/dashboard/sdk-demo`** page exercises login →
list → realtime end-to-end — hit it right after deploy to confirm the
frontend can reach the backend.

---

## 11. Ongoing operations

| Task | Command |
|---|---|
| Rolling update | `fly deploy` / `railway up` / `git push` |
| Read logs | `fly logs` / `railway logs` / Render dashboard |
| Backup DB | `pg_dump $DATABASE_URL \| gzip > backup-$(date +%F).sql.gz` |
| Restore | `gunzip -c backup.sql.gz \| psql $DATABASE_URL` |
| Rotate `SERVICE_ROLE_KEY` | `fly secrets set SERVICE_ROLE_KEY=...` → re-deploy |
| Scale up | Fly: `fly scale`; Railway: replica slider; Render: dashboard |

CI is wired in `.github/workflows/backend.yml` for auto-deploy on push
to `main`.
