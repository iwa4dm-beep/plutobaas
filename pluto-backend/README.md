# Pluto Backend

Self-hosted BaaS server (Fastify + Postgres + MinIO + Redis).
Deploy this to your VPS; then any website or app connects via `@pluto/js` SDK.

## Quick start (local dev)

```bash
cd pluto-backend
cp .env.example .env          # edit passwords + PLUTO_JWT_SECRET
pnpm install
pnpm docker:up                # postgres + redis + minio + api
pnpm migrate                  # apply SQL migrations
pnpm doctor                   # verify everything
```

Then hit:
- http://localhost:3000/livez
- http://localhost:3000/readyz
- http://localhost:3000/healthz
- http://localhost:3000/auth/v1/health

## Deploy on VPS

```bash
# 1. Install docker + docker-compose
curl -fsSL https://get.docker.com | sh

# 2. Clone this repo to /opt/pluto
sudo git clone <your-repo> /opt/pluto
cd /opt/pluto/pluto-backend

# 3. Configure
sudo cp .env.example .env
sudo nano .env                # set strong PLUTO_JWT_SECRET, POSTGRES_PASSWORD, S3 keys
sudo chmod 600 .env

# 4. Bring up
sudo docker compose -f docker/docker-compose.yml up -d
sudo docker compose -f docker/docker-compose.yml exec api node packages/api/scripts/migrate.mjs

# 5. Verify
sudo docker compose -f docker/docker-compose.yml exec api node packages/api/scripts/doctor.mjs

# 6. Nginx + certbot in front (see /opt/pluto/pluto-backend/docs/nginx.md)
```

## Wire the Lovable dashboard to this backend

In Lovable → Secrets, set:
- `PLUTO_UPSTREAM_URL` = `https://api.your-domain.com`
- `PLUTO_JWT_SECRET` = same value as VPS `.env`

TerminalCard probes on `/dashboard` will turn green.

## Roadmap

- [x] Phase 1 — Scaffold + health/liveness/readiness
- [x] Phase 2 — Auth service (`/auth/v1/*`) — signup, token, refresh (rotation + reuse detection), logout, user CRUD, recover, settings
- [x] Phase 3 — Data API (`/rest/v1/:table`, `/rest/v1/rpc/:fn`) — CRUD, filters, upsert, RLS via SET LOCAL role + request.jwt.claims
- [x] Phase 4 — `@pluto/js` SDK (auth + query builder + storage + realtime stub, Supabase-compatible)
- [x] Phase 5 — Storage (`/storage/v1/*`) — buckets, uploads (multipart + raw), streaming download, HEAD, delete, signed upload/download URLs, public URLs, MIME + size limits, S3/MinIO backend
- [x] Phase 6 — Realtime WebSocket (`/realtime/v1/websocket`) — postgres_changes (LISTEN/NOTIFY triggers), broadcast, presence; HTTP `/realtime/v1/broadcast` for server-side triggers
- [x] Phase 7 — Multi-tenant + Admin (`/admin/v1/*`)
- [x] Phase 8 — Prometheus metrics (`/metrics`), Edge Functions (`/functions/v1/*` — worker_threads sandbox), Email/SMTP (nodemailer) — signup verification + password recovery flows, `/dashboard/pluto-admin` UI

See `.lovable/plan.md` for the full blueprint.
- [x] Phase 9 — Governance: audit log, table grants, migrations, schema (indexes/constraints), safer SQL editor
- [x] Phase 10 — Backups & Restore (`/admin/v1/backups`, pg_dump/pg_restore), Webhooks & Event Triggers (`/admin/v1/webhooks`, HMAC-signed, retry/dead-letter), Search & Vector (`/admin/v1/search/fts`, `/admin/v1/search/vector` with pgvector), Billing (usage counters, quotas, alert rules)

### Phase 10 requirements

- `pg_dump` / `pg_restore` binaries must be on `$PATH` for the API container.
- `pgvector` extension optional; enable in your DB for vector search. Migration `0007_phase10.sql` auto-creates it if available.
- `PLUTO_BACKUP_DIR` must point at a persistent, writable directory.
- [x] Phase 11 — Database Branching (`/admin/v1/branches`, CREATE DATABASE ... TEMPLATE clones + promote + diff), GraphQL (`/graphql/v1/:project_id`, introspection-generated SDL + minimal executor), CLI (`@pluto/cli`) + typed TS SDK generator (`/admin/v1/sdk/generate`), Advanced Auth (OAuth authorize/callback for Google/GitHub/Apple/Azure/Discord/Facebook, TOTP MFA enroll/verify/challenge, SAML SP metadata + ACS)

### Phase 11 requirements

- Postgres role used by the API must have `CREATEDB` for database branching.
- `PUBLIC_API_URL` must be set for SDK generation and SAML metadata to include correct absolute URLs.
- Install the CLI globally: `npm install -g ./packages/cli` (or run `node packages/cli/bin/pluto.mjs`).
- OAuth `redirect_uri` must exactly match the value registered with each provider (e.g. `https://api.example.com/auth/v1/oauth/google/callback`).
- SAML support is minimal — production deployments should verify assertions with `samlify` or `@node-saml/node-saml` and enforce signed assertions.
