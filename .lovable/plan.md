# Pluto BaaS — পূর্ণাঙ্গ Backend-as-a-Service (MVP Core)

একটি open-source, self-hostable BaaS তৈরি করব — Supabase-এর সরলীকৃত সংস্করণ। তিনটি অংশে কাজ হবে: (1) Backend service, (2) Client SDK, (3) Admin Dashboard (এই Lovable project-এ)।

---

## ১. কী কী থাকবে (MVP Core Features)

**Authentication**
- Email + password sign-up / sign-in
- JWT access token (15 min) + refresh token (30 days)
- Password reset (email token)
- Email verification
- Session management, sign-out (all devices)
- Role-based access (user, admin)

**Database + Auto REST API**
- PostgreSQL backend
- যেকোনো table তৈরি করলে স্বয়ংক্রিয়ভাবে REST endpoint: `GET/POST/PATCH/DELETE /rest/v1/<table>`
- Query filters: `?col=eq.value`, `?col=gt.10`, `order`, `limit`, `offset`, `select=col1,col2`
- Row-Level Security (RLS) — PostgreSQL native policies; প্রতি request-এ JWT claim থেকে `current_user_id` set হবে
- Migrations CLI

**Storage**
- Buckets (public / private)
- File upload / download / delete
- Signed URLs (expiring)
- Local disk driver + S3-compatible driver (MinIO, AWS S3, R2)
- Access policies per bucket

**Admin Dashboard (এই Lovable project)**
- Login (super-admin)
- Project / API key management
- Table browser + row editor + SQL runner
- Users list, role assignment
- Storage bucket browser + upload
- Logs viewer (auth, API, errors)
- Settings (SMTP, storage driver, JWT secret rotation)

**Deployment**
- `docker-compose up` দিয়ে local run (Postgres + Backend + MinIO + Dashboard)
- VPS-এ deploy করার জন্য production compose + Caddy/Traefik reverse proxy
- AWS/GCP-এর জন্য Terraform module (Phase 2)
- Cloudflare Workers — edge-এ runtime সীমিত; SDK proxy compatible, full backend না (Phase 2)

**Client SDK (`@pluto/client`)**
- যেকোনো frontend (React, Vue, vanilla JS, React Native) থেকে call করার জন্য
- API: `pluto.auth.signUp/signIn/signOut`, `pluto.from('table').select().eq(...)`, `pluto.storage.from('bucket').upload(...)`
- Auto JWT refresh
- TypeScript types

---

## ২. Architecture

```text
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Your Frontend  │      │  Admin Dashboard│      │      CLI        │
│  (@pluto/client)│      │ (Lovable, this) │      │  (migrations)   │
└────────┬────────┘      └────────┬────────┘      └────────┬────────┘
         │ HTTPS/JWT              │ HTTPS/JWT              │
         └────────────┬───────────┴────────────────────────┘
                      │
              ┌───────▼────────┐
              │  Pluto Server  │  Node.js + Fastify
              │  /auth/v1      │
              │  /rest/v1      │
              │  /storage/v1   │
              │  /admin/v1     │
              └───┬────────┬───┘
                  │        │
         ┌────────▼──┐  ┌──▼──────────┐
         │ PostgreSQL│  │ Object Store│
         │  + RLS    │  │ (local/S3)  │
         └───────────┘  └─────────────┘
```

---

## ৩. Tech Stack

- **Runtime:** Node.js 20 + TypeScript (strict)
- **HTTP:** Fastify (high perf, schema validation)
- **DB driver:** `pg` + Kysely (type-safe query builder)
- **Auth:** `argon2` (password hash), `jose` (JWT)
- **Validation:** Zod
- **Storage:** local fs + `@aws-sdk/client-s3` (S3 driver)
- **Email:** Nodemailer (SMTP)
- **Tests:** Vitest + supertest
- **Container:** Docker + docker-compose
- **Dashboard:** এই TanStack Start project (এখানে যা আছে) — Pluto SDK দিয়ে নিজের backend-এর সাথে কথা বলবে

---

## ৪. Repository Layout (monorepo)

```text
pluto/
├── apps/
│   ├── server/              # Fastify backend
│   │   ├── src/
│   │   │   ├── modules/auth, rest, storage, admin
│   │   │   ├── db/ (migrations, kysely schema)
│   │   │   ├── middleware/ (jwt, rls, rate-limit, cors)
│   │   │   └── server.ts
│   │   ├── Dockerfile
│   │   └── package.json
│   └── dashboard/           # ← এই Lovable project এখানে থাকবে
├── packages/
│   ├── client-sdk/          # @pluto/client
│   ├── cli/                 # pluto migrate, pluto seed
│   └── shared-types/
├── docker-compose.yml       # local: postgres + minio + server + dashboard
├── docker-compose.prod.yml
└── README.md
```

---

## ৫. Build Phases

**Phase 1 — Foundation (এই Lovable project-এ Dashboard shell)**
1. Lovable project-এ Dashboard layout: sidebar (Auth, Database, Storage, Logs, Settings), top bar, login page
2. `@pluto/client` SDK stub তৈরি (interface ও mock data দিয়ে)
3. Dashboard pages গুলো mock data-তে fully interactive
4. Backend repo scaffold (আলাদা download করা যাবে এমন zip বা GitHub-ready structure)

**Phase 2 — Backend Auth + REST**
1. Fastify server + Postgres migrations
2. Auth module (sign-up, sign-in, refresh, reset, verify)
3. RLS-aware REST auto-generator
4. JWT middleware + per-request `SET LOCAL pluto.user_id`
5. Dashboard থেকে real backend-এ connect

**Phase 3 — Storage + Admin APIs**
1. Storage module (local + S3 driver)
2. Bucket policies, signed URLs
3. Admin APIs (users list, role grant, SQL runner)
4. Logs (auth + API access)

**Phase 4 — Packaging & Deploy**
1. Docker images (server, dashboard)
2. `docker-compose.yml` (local: Postgres, MinIO, Server, Dashboard, Mailpit)
3. Production compose + Caddy auto-HTTPS
4. Quickstart docs + integration examples (React, Next, Vue)

---

## ৬. Lovable Project-এ ঠিক কী হবে

এই TanStack Start project = **Admin Dashboard UI**। Lovable Cloud (Supabase) **enable করব না** — কারণ আমরা নিজস্ব backend বানাচ্ছি; dashboard শুধু Pluto Server-এর REST/Admin API call করবে।

পেজগুলো:
- `/auth` — admin login
- `/_authenticated/projects` — project & API key
- `/_authenticated/database` — table list, row editor, SQL runner
- `/_authenticated/auth` — users, roles
- `/_authenticated/storage` — buckets, file browser
- `/_authenticated/logs` — request/auth logs
- `/_authenticated/settings` — SMTP, storage driver, JWT rotation

Backend URL একটি env/setting থেকে নেবে যাতে local (`http://localhost:8000`) ও deployed (`https://api.yoursite.com`) দুটোতেই কাজ করে।

---

## ৭. Out of Scope (পরে যোগ করা যাবে)

Realtime (WebSocket), Edge Functions, GraphQL, OAuth (Google/GitHub), Vector/AI, multi-tenant projects, billing, Terraform IaC, managed Kubernetes Helm chart — এগুলো Phase 5+।

---

## ৮. প্রথম পদক্ষেপ (approve করলে)

1. এই Lovable project-এ Dashboard shell + sidebar + login page তৈরি
2. Mock `@pluto/client` SDK তৈরি যাতে UI পুরোপুরি interactive থাকে
3. পাশাপাশি backend repo scaffold (`apps/server/`) তৈরি — চাইলে আপনি GitHub-এ push করে নিজের machine-এ `docker-compose up` দিয়ে চালাতে পারবেন

বড় কাজ — কয়েক turn-এ পর্যায়ক্রমে করতে হবে। **Approve করলে Phase 1 দিয়ে শুরু করব।**