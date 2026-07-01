# Deploying Pluto BaaS

Pluto ships as a small stack of containers: `api` (Fastify), `postgres`
(state), `minio` (S3-compatible object storage), `mailpit` (dev SMTP), and
`caddy` (TLS + reverse proxy in production).

---

## 1. Local development

```bash
cd backend
docker compose up -d
docker compose logs -f api
```

| Service | URL                    | Notes                              |
| ------- | ---------------------- | ---------------------------------- |
| API     | http://localhost:8000  | `GET /healthz` returns `{ok:true}` |
| MinIO   | http://localhost:9001  | `minioadmin` / `minioadmin`        |
| Mailpit | http://localhost:8025  | catches all outgoing email         |

The default dev keys are `pk_anon_dev` and `sk_service_dev` — never use these
outside your laptop.

Create the default storage bucket once:

```bash
curl -X POST http://localhost:8000/storage/v1/buckets \
  -H "apikey: sk_service_dev" -H "content-type: application/json" \
  -d '{"name":"public","public":true}'
```

---

## 2. Self-hosted VPS (production)

Requirements: any Linux box with Docker + a DNS `A` record pointing to it.

```bash
git clone <your-fork> pluto && cd pluto/backend
sh scripts/gen-secrets.sh > .env       # or: cp .env.example .env && $EDITOR .env
# edit DOMAIN and ACME_EMAIL in .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env up -d
```

Caddy grabs a Let's Encrypt cert automatically on first request to `DOMAIN`.
`postgres`, `minio`, and `mailpit` are no longer exposed on the host — only
`caddy` on `:80/:443` is public.

**Backups.** Two persistent volumes matter:

```bash
docker run --rm -v pluto_pg_data:/data -v $PWD:/backup alpine \
  tar czf /backup/pg-$(date +%F).tgz -C /data .
docker run --rm -v pluto_pluto_storage:/data -v $PWD:/backup alpine \
  tar czf /backup/storage-$(date +%F).tgz -C /data .
```

Restore is `tar xzf` in the same location before `up -d`.

**Upgrading.**

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml build api
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

The api container runs migrations on startup, so schema changes ship
automatically.

---

## 3. Connecting a frontend

Install the SDK from this repo (or publish it to your registry):

```ts
import { createPlutoClient } from "@pluto/client";

export const pluto = createPlutoClient({
  url: "https://api.example.com",
  anonKey: import.meta.env.VITE_PLUTO_ANON_KEY,
});

// Auth
await pluto.auth.signUp({ email, password });
await pluto.auth.signIn({ email, password });

// Database (respects RLS via the signed-in user)
const { data, error } = await pluto
  .from("notes")
  .select("*")
  .eq("archived", "false")
  .order("created_at", { ascending: false });

// Storage
await pluto.storage.from("avatars").upload("me.png", file);
const { publicUrl } = pluto.storage.from("avatars").getPublicUrl("me.png");
```

Never ship the `SERVICE_ROLE_KEY` to a browser bundle. Use it only from
trusted backends and the admin dashboard.

---

## 4. Environment reference

| Var                 | Required | Default                       |
| ------------------- | -------- | ----------------------------- |
| `DATABASE_URL`      | ✓        | —                             |
| `JWT_SECRET`        | ✓        | — (min 16 chars, use 32+)     |
| `ANON_KEY`          | ✓        | —                             |
| `SERVICE_ROLE_KEY`  | ✓        | —                             |
| `STORAGE_DRIVER`    |          | `local`                       |
| `STORAGE_LOCAL_DIR` |          | `/var/lib/pluto/storage`      |
| `S3_ENDPOINT`       | s3       | —                             |
| `S3_ACCESS_KEY`     | s3       | —                             |
| `S3_SECRET_KEY`     | s3       | —                             |
| `S3_BUCKET`         | s3       | —                             |
| `S3_REGION`         |          | `us-east-1`                   |
| `SMTP_URL`          |          | (no outgoing mail if unset)   |
| `ACCESS_TOKEN_TTL_SEC`  |      | `900`                         |
| `REFRESH_TOKEN_TTL_SEC` |      | `2592000`                     |
| `PORT`              |          | `8000`                        |

---

## 5. Health & observability

- `GET /healthz` — cheap liveness probe (used by Docker + Caddy).
- `api_logs` table — structured logs from auth / rest / storage / admin.
  Query via the admin dashboard or `GET /admin/v1/logs`.
- Fastify uses pino JSON logs on stdout; ship them to any collector
  (Loki, Datadog, CloudWatch) with the standard docker log driver.
