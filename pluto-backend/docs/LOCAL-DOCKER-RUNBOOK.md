# Local Docker Runbook — Pluto Backend + `backend-joy` Frontend

লক্ষ্য: production যেভাবে চলে ঠিক সেভাবেই local machine এ পুরো stack (Postgres +
Redis + MinIO + API) ডকারে চালানো, এবং এই repo-র frontend (`backend-joy`) কে
সেই local API-র সাথে integrate করা।

---

## 0. Prerequisites

| Tool               | Version    | চেক                     |
| ------------------ | ---------- | ----------------------- |
| Docker Engine      | ≥ 24       | `docker --version`      |
| Docker Compose v2  | ≥ 2.20     | `docker compose version`|
| Node / Bun (front) | Bun ≥ 1.1  | `bun --version`         |
| Free RAM           | ≥ 4 GB     |                         |
| Free ports         | 3000, 5432, 6379, 9000, 9001 |     |

Windows-এ WSL2 backend চালু আছে কিনা নিশ্চিত করুন।

---

## 1. Clone + env prepare

```bash
git clone <this-repo> backend-joy
cd backend-joy/pluto-backend
cp .env.example .env
# .env-এ CHANGE_ME গুলো local-friendly value দিয়ে বদলান (নিচে দেখুন)।
```

Local-এ minimum যেগুলো বদলাতে হবে:

```dotenv
POSTGRES_PASSWORD=devpassword
DATABASE_URL=postgres://pluto:devpassword@postgres:5432/pluto
PLUTO_JWT_SECRET=$(openssl rand -hex 48)
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
CORS_ORIGINS=http://localhost:5173,http://localhost:8080
PUBLIC_API_URL=http://localhost:3000
SITE_URL=http://localhost:8080
```

> সব variable-এর বিস্তারিত ব্যাখ্যা আছে `pluto-backend/.env.example`-এ।

---

## 2. Stack চালু করা

```bash
cd pluto-backend
docker compose --env-file .env -f docker/docker-compose.yml up -d
docker compose --env-file .env -f docker/docker-compose.yml ps
```

Expected:
- `postgres` — healthy
- `redis`    — up
- `minio`    — up (console: http://localhost:9001, login `minioadmin/minioadmin`)
- `api`      — healthy (60s এর মধ্যে)

---

## 3. Migrations

প্রথমবার (বা schema বদলানোর পর):

```bash
docker compose --env-file .env -f docker/docker-compose.yml \
  -f docker/docker-compose.migrator.yml run --rm migrator
```

Health check:

```bash
curl -s http://localhost:3000/v1/health | jq
curl -s http://localhost:3000/readyz    | jq
```

দুইটাই `"status":"ok"` দিলে backend ready।

---

## 4. Frontend (`backend-joy`) integration

Repo-র root এ ফিরে গিয়ে:

```bash
cd ..
bun install
```

`.env.local` তৈরি করুন (Vite-এর জন্য):

```dotenv
VITE_PLUTO_URL=http://localhost:3000
VITE_PLUTO_ANON_KEY=<ANON_KEY from pluto-backend/.env>
```

তারপর:

```bash
bun run dev
# → http://localhost:8080
```

Dashboard-এ **Backend health audit** panel সবগুলো probe `OK` দেখালে
integration সম্পূর্ণ। "Create workspace" থেকে test workspace বানান।

---

## 5. Common commands

| কাজ                          | কমান্ড |
| ---------------------------- | ------ |
| API লগ live দেখা             | `docker compose -f docker/docker-compose.yml logs -f api` |
| Postgres shell               | `docker compose -f docker/docker-compose.yml exec postgres psql -U pluto -d pluto` |
| Redis shell                  | `docker compose -f docker/docker-compose.yml exec redis redis-cli` |
| Stack বন্ধ                   | `docker compose -f docker/docker-compose.yml down` |
| Data সহ wipe (⚠ destructive) | `docker compose -f docker/docker-compose.yml down -v` |
| Rebuild api image            | `docker compose -f docker/docker-compose.yml build api && docker compose -f docker/docker-compose.yml up -d api` |

---

## 6. Troubleshooting

- **`POSTGRES_PASSWORD must be set`** → `.env` load হচ্ছে না। কমান্ডে
  `--env-file .env` আছে কিনা এবং pwd সঠিক (`pluto-backend/`) কিনা দেখুন।
- **API unhealthy, log-এ `ECONNREFUSED postgres:5432`** → Postgres healthy
  হওয়ার আগেই api restart লুপে। `docker compose restart api` দিন।
- **CORS error frontend-এ** → `.env`-এ `CORS_ORIGINS` এ frontend-এর origin
  (`http://localhost:8080`) যোগ করে api restart করুন।
- **MinIO bucket missing** → api প্রথম boot-এ bucket auto-create করে; না
  হলে console (http://localhost:9001) → Buckets → Create → `pluto`।

---

## 7. Cleanup

```bash
docker compose --env-file .env -f docker/docker-compose.yml down -v
docker system prune -f
```
