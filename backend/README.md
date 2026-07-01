# Pluto BaaS — Backend

Self-hosted Backend-as-a-Service: Auth, auto-generated REST API on top of PostgreSQL, and Storage. Connect from any frontend with `@pluto/client`.

## Quick start (local)

```bash
docker compose up -d
# API:    http://localhost:8000
# MinIO:  http://localhost:9001  (admin / minioadmin)
# Mailpit http://localhost:8025
```

Run the admin dashboard separately (the Lovable project in this workspace) and point it at `http://localhost:8000`.

## Endpoints

| Group       | Path prefix     | Description                                  |
| ----------- | --------------- | -------------------------------------------- |
| Auth        | `/auth/v1/*`    | sign-up, sign-in, refresh, reset, verify     |
| Database    | `/rest/v1/*`    | auto REST for every public table (RLS aware) |
| Storage     | `/storage/v1/*` | buckets + objects + signed URLs              |
| Admin       | `/admin/v1/*`   | dashboard-only (service-role key required)   |
| Health      | `/healthz`      | liveness                                     |

## Environment

| Var                  | Description                          |
| -------------------- | ------------------------------------ |
| `DATABASE_URL`       | postgres://user:pass@host:5432/db    |
| `JWT_SECRET`         | HMAC secret for access tokens        |
| `ANON_KEY`           | Public API key (frontend-safe)       |
| `SERVICE_ROLE_KEY`   | Admin key — never expose to browser  |
| `STORAGE_DRIVER`     | `local` \| `s3`                      |
| `STORAGE_LOCAL_DIR`  | Path on disk when driver=local       |
| `S3_ENDPOINT`        | e.g. `http://minio:9000`             |
| `S3_BUCKET`          | Default bucket name                  |
| `SMTP_URL`           | smtp://user:pass@host:port           |
| `PORT`               | Defaults to 8000                     |

## Production

`docker-compose.prod.yml` adds Caddy with automatic HTTPS:

```bash
DOMAIN=api.example.com docker compose -f docker-compose.prod.yml up -d
```

## Status

- [x] Repository scaffold
- [x] docker-compose (postgres + minio + mailpit + api)
- [x] Auth module — argon2id + JWT + rotating refresh tokens (Phase 2)
- [x] REST auto-generator — PostgREST-style, RLS via `pluto.user_id` GUC (Phase 2)
- [x] `@pluto/client` SDK — fetch-based, browser/node/edge (Phase 2)
- [x] Storage module — local + S3 drivers, buckets, signed URLs, public objects (Phase 3)
- [x] Admin API — users, tables, SQL runner, logs, stats (Phase 3)
- [ ] Realtime, Edge Functions, OAuth (Phase 5+)

## Using `@pluto/client`

```ts
import { createPlutoClient } from "@pluto/client";
const pluto = createPlutoClient({ url: "http://localhost:8000", anonKey: "pk_anon_dev" });

await pluto.auth.signUp({ email: "me@example.com", password: "correct horse" });
const { data, error } = await pluto.from("notes").select("*").order("created_at", { ascending: false });
```
