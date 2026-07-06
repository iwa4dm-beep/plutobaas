# Customer Onboarding Flow — Plan

গ্রাহক signup করলে **automatically** সব setup হবে — workspace, API keys, CORS, welcome email, demo data। দুইভাবে account তৈরি হবে: **self-serve** (public signup page) এবং **admin invite** (আপনি dashboard থেকে)।

---

## 🎯 কী কী তৈরি হবে

### A. Backend (pluto-backend, VPS-এ deploy)

1. **`POST /auth/v1/signup-full`** — self-serve endpoint (public, rate-limited)
   - Input: `email`, `password`, `workspace_name`, `initial_domain?`
   - Transaction-এ:
     - `auth.users`-এ user create
     - `admin.workspaces`-এ workspace create (owner = user)
     - `admin.projects`-এ default project create
     - `admin.workspace_api_keys`-এ anon + service_role key mint
     - Domain দিলে `admin.cors_origins`-এ workspace-scoped row insert
     - Sample data seed (customers/orders demo tables in user's schema)
     - `admin.email_queue`-এ welcome email enqueue
   - Response: `{ user, workspace, project, keys: { anon, service_role }, cors_added }`

2. **`POST /admin/v1/invite`** — admin-only invite (requires superadmin JWT)
   - Same flow, but email = invite link with one-time token
   - User পরে link click করে password set করবে

3. **`POST /admin/v1/projects/:id/domains`** — গ্রাহক নিজের domain add করলে auto-CORS
   - Workspace member check → `admin.cors_origins`-এ insert → cache invalidate

4. **Welcome email template + queue worker**
   - SMTP already configured (`.env`-এ `SMTP_URL` আছে)
   - Simple HTML template with quick-start snippet + keys

5. **Sample data seed function** (`admin.seed_demo_data(project_id)`)
   - `customers` (name, email) + `orders` (customer_id, total, status) tables
   - ৫টা করে dummy rows

6. **Migration `0028_onboarding.sql`** — email_queue table + demo seed function + audit hooks

### B. Frontend (src/routes, Lovable dashboard)

1. **`/signup`** — public self-serve page
   - Form: email, password, workspace name, optional domain
   - Success → auto-login → redirect to `/onboarding`

2. **`/onboarding`** — first-run wizard (3 steps)
   - Step 1: "Your keys" — show anon + service_role, copy buttons, warnings
   - Step 2: "Add your website" — domain input → auto-CORS
   - Step 3: "Try the SDK" — copy-paste snippet, test button

3. **`/dashboard/domains`** — manage domains per workspace
   - List + add/remove — same as CORS but workspace-scoped

4. **`/dashboard/admin/invite`** — superadmin only
   - Send invite email to new customer

---

## 🔒 Security

- `signup-full` rate-limit: **5/min per IP** (protect against abuse)
- Password: min 8 chars, HIBP check optional (later)
- Workspace slug: auto-generate from email/name, uniqueness enforced
- Invite token: single-use, 48h expiry, sha256 hashed in DB
- Domain input: same strict regex as CORS registry (`^https?://host(:port)?$`)
- Every mutation → audit_log row

## 📧 Email

SMTP already configured on VPS. Welcome email includes:
- Workspace name + login link
- **anon key** (safe to show in email)
- **NOT service_role** (only shown once in dashboard)
- Quick-start curl + JS SDK snippets

## 📊 Data Flow Diagram

```text
Self-serve:
  Public signup form ──POST──▶ /auth/v1/signup-full
                                    │
                                    ├─▶ auth.users + workspace + project + keys
                                    ├─▶ admin.cors_origins (if domain given)
                                    ├─▶ seed demo tables
                                    └─▶ enqueue welcome email
                                    ▼
                            Auto-login → /onboarding wizard

Admin invite:
  Dashboard /admin/invite ──POST──▶ /admin/v1/invite (superadmin JWT)
                                    │
                                    ├─▶ Create shell user + workspace/project/keys
                                    └─▶ enqueue invite email (with token link)
                                    ▼
                            User clicks link → sets password → /onboarding
```

---

## 📦 Files

**Backend (pluto-backend):**
- `migrations/0028_onboarding.sql` — email_queue, invites, seed function
- `packages/api/src/routes/onboarding.ts` — signup-full + domain endpoints
- `packages/api/src/routes/invites.ts` — admin invite + accept
- `packages/api/src/email/queue.ts` — SMTP worker (polling every 10s)
- `packages/api/src/email/templates/welcome.ts`, `invite.ts`
- `packages/api/src/onboarding/seed.ts` — sample data
- `packages/api/src/server.ts` — register new routes + start email worker

**Frontend (src):**
- `src/routes/signup.tsx` — public signup page
- `src/routes/accept-invite.tsx` — invite link landing
- `src/routes/onboarding.tsx` — 3-step wizard
- `src/routes/dashboard.domains.tsx` — workspace domain manager
- `src/routes/dashboard.admin.invite.tsx` — superadmin invite form
- `src/lib/pluto/live.ts` — add `onboarding.signup`, `invites.*`, `domains.*` clients

---

## 🚀 Deploy Steps (আপনার VPS-এ)

1. `git pull` (আমার code push-এর পর)
2. `docker compose build --no-cache api && docker compose up -d api`
3. Migration auto-run হবে (`AUTO_MIGRATE=1`)
4. Frontend Lovable-এ auto-deploy

---

## ⏱️ Approval-এর পর ধাপে ধাপে build (৪ turns)

- **Turn 1:** Migration + backend `signup-full` + CORS auto-add endpoint
- **Turn 2:** Email queue + templates + invite flow
- **Turn 3:** Frontend signup page + onboarding wizard
- **Turn 4:** Domain manager + admin invite UI + end-to-end test guide

**Approve করলে** Turn 1 দিয়ে শুরু করব।
