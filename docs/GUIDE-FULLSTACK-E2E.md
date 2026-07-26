# Pluto BaaS — Fullstack E2E Integration Guide

> শূন্য থেকে production পর্যন্ত একটি fullstack অ্যাপ Pluto BaaS-এর সাথে যুক্ত করার সম্পূর্ণ ধাপে ধাপে গাইড। প্রত্যেক Phase-এ **Goal → Steps → Verify → Common errors → Rollback** থাকবে।

Related dashboard tools:
- `/dashboard/projects` — Projects & API Keys
- `/dashboard/database`, `/dashboard/sql`, `/dashboard/migrations`
- `/dashboard/rbac-debug`, `/dashboard/ops/jwt-inspect`
- `/dashboard/ops/migrations`, `/dashboard/ops/rls-debug`, `/dashboard/ops/explain`, `/dashboard/ops/docker-check`
- `/dashboard/ops`, `/dashboard/ops/executions`, `/dashboard/ops/settings`

---

## Phase 0 — Prerequisites

**Goal:** Local ও VPS environment ready রাখা।

**Steps:**
- VPS: Ubuntu 22.04/24.04, root/sudo access, ≥ 2 vCPU / 4 GB RAM.
- DNS: একটি apex domain (`example.com`) + wildcard `*.example.com` A-record VPS IP-এ।
- Local: `node ≥ 20`, `bun` বা `pnpm`, `git`, `docker`, `docker compose`.
- একটি GitHub repo যেখানে আপনার frontend/fullstack code আছে।

**Verify:**
```bash
node -v && bun -v && docker --version && docker compose version
dig +short app.example.com
```

**Common errors:** DNS propagate হতে ৩০ মিনিট পর্যন্ত সময় নিতে পারে — `dnschecker.org` দিয়ে যাচাই করুন।

---

## Phase 1 — Workspace + Project তৈরি

**Goal:** Pluto dashboard-এ একটি workspace ও প্রথম project তৈরি করা।

**Steps:**
1. `https://dashboard.timescard.cloud/auth` — সাইন ইন করুন।
2. Sidebar → **Workspaces** → *Create workspace* → slug দিন (kebab-case)।
3. **Projects & Keys** → *Create project* → নাম দিন → save।

**Verify:** URL bar-এ workspace context set হবে; project list-এ নতুন প্রজেক্ট আসবে।

**Rollback:** Project card → *Delete* (only if empty)।

---

## Phase 2 — API Keys (anon + service_role)

**Goal:** Frontend ও server-side calls-এর জন্য key mint করা।

**Steps:**
1. **Projects & Keys** → target project → *Mint key*।
2. **anon (publishable)** — codebase-এ safe (`VITE_PLUTO_ANON_KEY`)।
3. **service_role (secret)** — শুধু backend/edge functions-এ। কখনো frontend-এ নয়।

**Verify:**
```bash
curl -s https://api.timescard.cloud/v1/health -H "apikey: <anon>" | jq .
```

**Common errors:**
- `duplicate key ... api_keys_project_name_idx` — একই role-এ একই নামে key exist করছে। **Resolve** বাটন ব্যবহার করে rename/revoke করুন।
- 401 unauthorized — `apikey` header বা bearer JWT না থাকলে।

**Rollback:** Key row → *Revoke* → new mint।

---

## Phase 3 — Database Schema (Migration + RLS + GRANT)

**Goal:** Public schema-এ tenant table তৈরি করা, RLS enable + policy + GRANT নিশ্চিত করা।

**Steps:**
1. `pluto-backend/migrations/00XX_<name>.sql` তৈরি করুন।
2. Structure (**public schema-এ প্রতিটি table-এর জন্য বাধ্যতামূলক ক্রম**):

```sql
-- 1. CREATE TABLE
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  title text not null,
  body text,
  created_at timestamptz not null default now()
);

-- 2. GRANTS (Data API access; RLS alone নয়)
grant select, insert, update, delete on public.notes to authenticated;
grant all on public.notes to service_role;
-- anon read চাইলে: grant select on public.notes to anon;

-- 3. ENABLE RLS
alter table public.notes enable row level security;

-- 4. POLICIES
create policy notes_owner_select on public.notes
  for select to authenticated
  using (user_id = auth.uid());

create policy notes_owner_write on public.notes
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
```

3. Roles alada table-এ (never on profiles):
```sql
create type public.app_role as enum ('admin','moderator','user');
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.user_roles where user_id=_user_id and role=_role)
$$;
```

**Verify (dashboard):**
- `/dashboard/ops/migrations` → **Plan** → **Dry-run** → confirm expected DDL → **Apply**।
- `/dashboard/ops/rls-debug` → sample query দিয়ে দেখান কোন policy hit করছে।
- `/dashboard/ops/explain` → indexes ঠিক আছে কি না।

**Common errors:**
- `permission denied for table` → GRANT missing। fix migration re-run।
- Infinite recursion in policy → policy inside role-check ব্যবহার করছেন profile-এর column-এ; `has_role()` security-definer function ব্যবহার করুন।

**Rollback:**
```bash
sudo /usr/local/sbin/pluto-ops migrate rollback --to 00XX
```
বা `/dashboard/ops/migrations` → *Rollback to version*।

---

## Phase 4 — Auth (Email/Password + JWT)

**Goal:** End-user সাইন-আপ/সাইন-ইন এবং JWT propagation সঠিকভাবে কাজ করা।

**Steps:**
1. Dashboard → **Auth & Users** → email/password provider enable।
2. Client-side:
```ts
import { createPlutoClient } from "@pluto/js";
export const pluto = createPlutoClient({
  url: import.meta.env.VITE_PLUTO_URL,
  anonKey: import.meta.env.VITE_PLUTO_ANON_KEY,
});
await pluto.auth.signUp({ email, password });
await pluto.auth.signInWithPassword({ email, password });
```
3. Session storage automatic; refresh flow SDK-এ built-in।

**JWT claims পাবেন:**
- `sub` — user id
- `role` — `authenticated` বা custom
- `is_superadmin` — boolean flag (workspace-level)

**Verify:**
- `/dashboard/ops/jwt-inspect` — paste token → decoded header/payload/expiry দেখুন।
- `/dashboard/rbac-debug` — logged-in user-এর effective role ও gate verdicts।

**Common errors:**
- `PlutoAuthError_401 Session expired` → SDK automatic refresh করবে; না হলে `/auth`-এ redirect হবে (built-in fallback)।
- `Owner access required` — `is_superadmin` propagate হয়নি; rebuild dashboard।

---

## Phase 5 — Frontend Wiring

**Goal:** SPA/SSR frontend থেকে Pluto call করা।

**Steps:**
1. Install SDK:
```bash
bun add @pluto/js
```
2. `.env` (build-time):
```
VITE_PLUTO_URL=https://api.timescard.cloud
VITE_PLUTO_ANON_KEY=<publishable>
```
3. **Runtime env** (Docker/VPS deploy)-এ `env.js` inject করে ship করুন:
```bash
bash pluto-backend/deploy/inject-pluto-env.sh
```
4. Data fetch:
```ts
const { data, error } = await pluto.from("notes").select("*").order("created_at", { ascending: false });
```

**Verify:** DevTools → Network → request-এ `apikey` header ও `Authorization: Bearer <jwt>` দেখুন।

**Common errors:**
- `Failed to fetch` / CORS → `/dashboard/cors` → origin whitelist যোগ করুন।
- `no rows returned` while data exists → RLS policy user_id মিলছে না; `/dashboard/ops/rls-debug` চেক করুন।

---

## Phase 6 — Storage + Realtime

**Goal:** File upload ও live subscription।

**Steps:**
```ts
// Storage
await pluto.storage.from("avatars").upload(`${userId}/pic.png`, file);
const { data: { publicUrl } } = pluto.storage.from("avatars").getPublicUrl(path);

// Realtime
pluto.channel("notes-changes")
  .on("postgres_changes", { event: "*", schema: "public", table: "notes" },
      (payload) => console.log(payload))
  .subscribe();
```

**Verify:** `/dashboard/storage` → object list; browser DevTools → WS `wss://api.timescard.cloud/realtime/v1` connected।

**Common errors:**
- WS 404 → Nginx-এ `/realtime/v1` proxy missing; `bash pluto-backend/deploy/repair-realtime-ws.sh` চালান।
- Storage 403 → bucket policy/RLS চেক করুন।

---

## Phase 7 — Edge Functions / RPC (Server-side)

**Goal:** Secret-বহনকারী server logic।

**Steps:**
1. RPC (PostgREST):
```sql
create or replace function public.get_my_stats()
returns jsonb language sql stable security definer set search_path=public
as $$ select jsonb_build_object('total', count(*)) from public.notes where user_id = auth.uid() $$;
grant execute on function public.get_my_stats() to authenticated;
```
```ts
const { data } = await pluto.rpc("get_my_stats");
```
2. Edge Function (`/dashboard/functions`) → env-এ `PLUTO_SERVICE_KEY` inject করুন।

**Verify:** Function invoke → response ও logs (`/dashboard/logs-explorer`)।

**Common errors:** `service_role` key frontend-এ leak না হয় নিশ্চিত করুন; scanning-এ ধরা পড়লে immediately revoke + rotate।

---

## Phase 8 — Custom Domain + SSL

**Goal:** `app.example.com` কে primary frontend হিসেবে pin করা।

**Steps:**
1. DNS: `A app.example.com → <VPS IP>`; wildcard optional।
2. Wildcard TLS:
```bash
sudo bash pluto-backend/deploy/install-wildcard-tls.sh example.com
```
3. Primary pin:
```bash
sudo bash pluto-backend/deploy/set-primary-frontend.sh <slug> app.example.com
```

**Verify:**
```bash
curl -sI https://app.example.com/ | grep -i x-pluto-primary
# expected: X-Pluto-Primary: <slug>
```

**Common errors:**
- Header missing → Nginx reload হয়নি; `sudo nginx -t && sudo systemctl reload nginx`।
- `Too many levels of symbolic links` → stale `_primary/current` symlink; script re-run absolute path দিয়ে।

**Rollback:** `bash pluto-backend/deploy/free-app-domain.sh app.example.com` → পুরনো slug pin restore।

---

## Phase 9 — Deploy + Cutover

**Goal:** GitHub → VPS → live in one command।

**Steps:**
```bash
# On VPS
bash pluto-backend/deploy/safe-pull.sh
bash pluto-backend/deploy/build-and-cutover.sh <slug>
```
বা dashboard: **Auto-Deploy Studio** → GitHub URL → *Deploy*।

**Verify:**
- `curl -s https://api.timescard.cloud/v1/health` → `{ ok: true }`
- Frontend load → login → dashboard render → no console errors।
- `/dashboard/ops/executions` → latest job **succeeded**।

**Common errors:**
- Build fails `TDZ / Cannot access 'S' before initialization` → Vite `manualChunks` strip করুন; rebuild।
- `apply_failed: column does not exist` → migration re-order/idempotent (`if not exists`)।

**Rollback:** `/dashboard/ops` → *Rollout* → previous release; বা `/dashboard/deployment-history` → *Rollback to*।

---

## Phase 10 — Observability + Ops (Production hygiene)

**Goal:** Live অ্যাপ safely চালানো।

**Configure:**
- `/dashboard/ops/settings` — webhook secret (HMAC signed), retention policy, prod approval reviewers।
- `/dashboard/traces/settings` — PII redaction rules (requires superadmin)।
- `/dashboard/backups` — schedule + retention।

**Daily workflow:**
1. Change → PR → merge to `main`।
2. Auto-Deploy Studio → **Dry-run** → **Approve (prod)** → **Apply**।
3. `/dashboard/ops/executions` — timeline monitor।
4. Post-deploy: `/dashboard/verify` checklist green।

**Debug toolbox:**
| সমস্যা | পৃষ্ঠা |
|---|---|
| 403 / access denied | `/dashboard/ops/rls-debug`, `/dashboard/rbac-debug` |
| Slow query | `/dashboard/ops/explain` |
| Token / role mismatch | `/dashboard/ops/jwt-inspect` |
| Container / DB connectivity | `/dashboard/ops/docker-check` |
| Migration issue | `/dashboard/ops/migrations` |
| Live errors | `/dashboard/logs-explorer`, `/dashboard/traces` |

**Rollback strategy:**
- Frontend: previous release symlink।
- Backend service: `sudo /usr/local/sbin/pluto-ops rollout rollback --env prod`।
- DB: `pluto-ops migrate rollback --to <version>` + latest backup restore fallback।

---

## Cheat-sheet — এক নজরে সব কমান্ড

```bash
# Env inject + build + cutover
bash pluto-backend/deploy/inject-pluto-env.sh
bash pluto-backend/deploy/build-and-cutover.sh <slug>

# Migrations
sudo /usr/local/sbin/pluto-ops migrate plan
sudo /usr/local/sbin/pluto-ops migrate dry-run
sudo /usr/local/sbin/pluto-ops migrate apply
sudo /usr/local/sbin/pluto-ops migrate rollback --to 00XX

# Rollouts / backups
sudo /usr/local/sbin/pluto-ops rollout apply   --env prod
sudo /usr/local/sbin/pluto-ops rollout rollback --env prod
sudo /usr/local/sbin/pluto-ops backup create   --env prod
sudo /usr/local/sbin/pluto-ops backup prune    --env prod

# Live probes
curl -sI https://<domain>/ | grep -i x-pluto-primary
curl -s  https://api.timescard.cloud/v1/health | jq .
```

---

## Golden rules

1. **Roles আলাদা table-এ** (`user_roles`) — profile-এ কখনো role রাখবেন না।
2. **প্রতিটি public table-এ CREATE → GRANT → ENABLE RLS → POLICY** — এই ক্রম বাধ্যতামূলক।
3. **service_role কখনো frontend-এ নয়** — শুধু server-side/edge functions-এ।
4. **Migration idempotent** (`if not exists`, `create or replace`) — production safe re-run।
5. **Deploy = dry-run first** — prod destructive action সর্বদা approval gate পার হবে।
