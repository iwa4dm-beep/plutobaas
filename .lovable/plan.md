
# Pluto BaaS — Full Production Blueprint

লক্ষ্য: এমন একটি self-hosted BaaS তৈরি করা যা VPS-এ deploy করলে **যেকোনো external website/app** (React, Next, mobile, vanilla JS) সহজেই connect করে auth, database, storage, realtime, functions সব ব্যবহার করতে পারবে — অনেকটা self-hosted Supabase-এর মতো।

---

## Architecture Overview

```text
┌──────────────────────────────────────────────────────────────┐
│  External Apps (any website / mobile / SPA)                  │
│      import { createClient } from '@pluto/js'                │
└───────────────┬──────────────────────────────────────────────┘
                │ HTTPS + JWT (publishable key)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Nginx (TLS, rate limit, CORS, upload cap)                   │
└───────────────┬──────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Fastify API  (PM2 cluster, 2+ workers)                      │
│  ├── /auth/v1/*      signup, login, refresh, oauth, user     │
│  ├── /rest/v1/:table PostgREST-style CRUD (RLS enforced)     │
│  ├── /rpc/:fn        Postgres function calls                 │
│  ├── /storage/v1/*   file upload/download (S3 or disk)       │
│  ├── /realtime/v1    WebSocket (LISTEN/NOTIFY bridge)        │
│  ├── /functions/v1   user Edge Functions (isolated-vm)       │
│  ├── /admin/*        project & API key management            │
│  ├── /healthz /livez /readyz                                 │
│  └── /api/pluto/*    monitor, status                         │
└───────┬──────────────┬──────────────┬────────────────────────┘
        ▼              ▼              ▼
   PostgreSQL      MinIO/S3       Redis (rate-limit, cache)
   (per-project    (files)        (pub/sub for realtime)
    schema)
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Lovable Dashboard (this app) — admin control panel          │
│  DB manager, users, storage, secrets, monitor                │
└──────────────────────────────────────────────────────────────┘
```

---

## Deliverables (7 phases, incremental)

### Phase 1 — Backend Monorepo Scaffold  `pluto-backend/`
- `pnpm` workspaces: `packages/api`, `packages/sdk-js`, `packages/cli`, `packages/shared`
- Fastify 5, TypeScript strict, Drizzle ORM, Zod, Pino logger
- Dockerfile + docker-compose (Postgres 16 + MinIO + Redis + API)
- Migrations runner (`drizzle-kit`)
- Ships with: `/healthz` `/livez` `/readyz` (already-drafted code lifted from this project)

### Phase 2 — Auth Service  `/auth/v1/*`
- Endpoints: `signup`, `verify`, `token` (password + refresh grant), `logout`, `user`, `recover`, `otp`, `oauth/:provider`, `jwks`
- JWT: RS256, JWKS endpoint, refresh-token rotation with reuse-detection
- Providers: email/password, magic link, Google, GitHub (pluggable)
- Password hashing: argon2id
- Rate-limits: `10/min` on `token`, `3/min` on `signup`
- Postgres schema: `auth.users`, `auth.sessions`, `auth.identities`, `auth.refresh_tokens`
- Emails via SMTP (Resend/SES/Mailgun adapter)

### Phase 3 — Data API  `/rest/v1/:table` (PostgREST-like)
- CRUD: `GET/POST/PATCH/DELETE`
- Filters: `?col=eq.value`, `gt`, `lt`, `like`, `in`, `is`, `not`
- `select=col1,col2`, `order`, `limit`, `offset`, `range` header
- Embedded resources: `select=*,posts(*)`
- Bulk insert, upsert (`Prefer: resolution=merge-duplicates`)
- **RLS enforced** — request runs as `authenticated` role with `request.jwt.claims` set from bearer token
- `/rpc/:fn` for calling Postgres functions

### Phase 4 — Public SDK  `@pluto/js` (published to npm)
Supabase-compatible surface so migration is trivial:
```ts
import { createClient } from '@pluto/js'
const pluto = createClient('https://api.mysite.com', PUBLISHABLE_KEY)

await pluto.auth.signUp({ email, password })
await pluto.auth.signInWithPassword({ email, password })
pluto.auth.onAuthStateChange((event, session) => {})

const { data, error } = await pluto
  .from('posts').select('*, author(*)').eq('published', true)

await pluto.storage.from('avatars').upload('me.png', file)
pluto.channel('room-1').on('postgres_changes', {...}, cb).subscribe()
```
- Auto token refresh, localStorage session persistence
- SSR-safe (cookies adapter)
- Also ships UMD bundle for `<script>` CDN use
- TypeScript types generated from DB schema (`pluto gen types`)

### Phase 5 — Storage Service  `/storage/v1/*`
- Buckets (public/private) with RLS-style policies
- Multipart upload for large files
- Image transforms (resize/format) via `sharp` sidecar service
- S3-compatible backend (MinIO on same VPS, or external S3)
- Signed URLs with expiry

### Phase 6 — Realtime  `/realtime/v1` (WebSocket)
- Postgres logical replication → broadcast row changes
- `postgres_changes` events (INSERT/UPDATE/DELETE) filtered by RLS
- `broadcast` (client-to-client messaging)
- `presence` (who is online in a channel)
- Redis pub/sub for multi-worker fan-out

### Phase 7 — Multi-Tenant + Admin
- One VPS can host multiple "projects" (like Supabase projects)
- Each project = separate Postgres schema + isolated API keys + JWT secret
- `pluto` CLI: `pluto init`, `pluto db push`, `pluto secrets set`, `pluto deploy`
- Admin API (`/admin/*`) consumed by the Lovable dashboard (this app) — service-role token required
- Publishable key (client-safe) + service-role key (server-only) per project

---

## Dashboard Integration (this Lovable app)

Once backend is live, this app becomes the **control plane**:
- Set `PLUTO_UPSTREAM_URL=https://api.your-vps.com` in secrets
- Set `PLUTO_SERVICE_ROLE_KEY` (server-only, for admin ops)
- All existing pages (`/dashboard/database`, `/auth`, `/storage`, `/functions`) become live
- New pages: **API Keys**, **Projects**, **Realtime inspector**, **Logs viewer**

---

## Security Baseline
- All endpoints: Zod input validation, rate limit, request size cap
- JWT: RS256, 1h access token, 30d refresh with rotation + reuse detection
- Argon2id password hashing
- RLS mandatory on every user-facing table
- Service-role key never leaves server, stored via Lovable secrets
- Audit log table (`admin.audit`) — every admin action logged
- CORS: allowlist per project (configured via admin API)

---

## Deployment (VPS)
- Single `docker-compose up -d` brings up Postgres + Redis + MinIO + API + Nginx
- Certbot auto-TLS
- PM2 optional if not using Docker
- Daily `pg_dump` + MinIO snapshot to remote S3 (backup script included)
- `pluto doctor` CLI = extended version of `validate-env.mjs` — checks every service

---

## Implementation Order (what I will build, per turn)

Each phase is one turn's worth of work — I will build them sequentially, verifying each before moving on:

1. **Turn 1** — Scaffold `pluto-backend/` monorepo: Fastify app, Docker compose, migrations, `/healthz`, `/livez`, `/readyz` (Phase 1)
2. **Turn 2** — Auth service full implementation (Phase 2)
3. **Turn 3** — Data API + RLS bridge (Phase 3)
4. **Turn 4** — `@pluto/js` SDK package (Phase 4)
5. **Turn 5** — Storage service (Phase 5)
6. **Turn 6** — Realtime WebSocket gateway (Phase 6)
7. **Turn 7** — Multi-tenant + Admin API + Dashboard wiring (Phase 7)
8. **Turn 8** — Deployment scripts, backup, doctor CLI, docs

---

## Location of Backend Code

**Important**: Backend code (Fastify server) will live in a **new folder `pluto-backend/`** at project root. It is **NOT** part of the Lovable frontend build — it's a standalone Node.js app you deploy to your VPS. The Lovable frontend stays as the admin dashboard that talks to it over HTTPS.

---

## Approval Requested

Approve করলে আমি **Phase 1 (Backend Monorepo Scaffold)** থেকে শুরু করবো এই turn-এই। প্রতি phase শেষে verify করে next phase-এ যাবো।

চাইলে phase order পরিবর্তন করতে পারেন (যেমন: Storage আগে চান, Realtime পরে) — জানালে সেভাবে সাজাবো।
