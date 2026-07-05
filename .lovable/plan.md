
## লক্ষ্য

Frontend-কে existing `backend/apps/server` (Fastify + Postgres) এর সাথে যুক্ত করা, mock `pluto` client-কে real HTTP calls-এ রূপান্তর, TerminalCard-এর "Failed to fetch" ঠিক করা, এবং Stripe checkout চালু।

## Scope (এই কয়েকটি টার্নে)

### ১. Backend bridge (TanStack server routes)
`src/routes/api/public/health/*.ts` — ৮টা health probe endpoint যেগুলো:
- `PLUTO_UPSTREAM_URL` env থাকলে সেখানে proxy করে (production/self-host)
- না থাকলে graceful `{ status: "offline", reason: "backend not configured" }` return করে (dev fallback, no more `Failed to fetch`)

Endpoints: `/readyz`, `/auth/v1/health`, `/rest/v1/`, `/storage/v1/`, `/realtime/v1/`, `/functions/v1/`, `/jobs/v1/`, `/admin/v1/stats`

### ২. Real client (`src/lib/pluto/client.ts` refactor)
- Adapter pattern: `VITE_PLUTO_URL` set থাকলে real Fastify calls, না থাকলে existing localStorage mock (backward compat)
- Modules covered this turn: `auth` (signup/signin/signout/session), `projects`, `users` (list/roles), `storage` (buckets/objects), `sql` (query), `functions` (list/invoke)
- Real calls যাবে `backend/packages/client-sdk` API surface অনুযায়ী

### ৩. Auth security tightening (frontend side)
- `auth-context.tsx` — real JWT session verify, `has_role()` RPC call for admin gates
- Token attached automatically via TanStack `functionMiddleware`
- Sign-out → clear tokens + `router.invalidate()`

### ৪. Stripe payments (Lovable built-in)
- `payments--enable_stripe_payments` tool call করে enable
- Plan selection UI (already exists in `dashboard.usage.tsx`) → real checkout session
- Products setup পরের টার্নে user input নিয়ে

## Out of scope (পরের টার্নের কাজ)
- Backend server deployment/hosting (docs already ready in `backend/DEPLOY.md`, `CLOUD_DEPLOY.md`)
- E2E tests expansion, production error sink (Sentry/etc.), full audit log persistence UI
- Cloud (Supabase) enable — Fastify backend চাওয়ায় প্রয়োজন নেই

## Technical shape

```text
src/routes/api/public/health/
├── readyz.ts
├── auth.ts          → /auth/v1/health
├── rest.ts          → /rest/v1/
├── storage.ts       → /storage/v1/
├── realtime.ts      → /realtime/v1/
├── functions.ts     → /functions/v1/
├── jobs.ts          → /jobs/v1/
└── admin-stats.ts   → /admin/v1/stats

src/lib/pluto/
├── client.ts        → adapter: real vs mock
├── live.ts          → real HTTP calls (expanded)
└── auth-context.tsx → real JWT + has_role
```

Env vars needed:
- `VITE_PLUTO_URL` (frontend) — https://api.yourdomain.com
- `VITE_PLUTO_ANON_KEY` (frontend, publishable)
- `PLUTO_UPSTREAM_URL` (server-only, for health proxy)

## Confirmation লাগবে

1. Fastify backend আপনি নিজে VPS-এ deploy করবেন (আমি deploy করি না) — deploy guide আগের turn-এ দেওয়া আছে। ✅ ধরে নিচ্ছি।
2. Stripe enable করতে গেলে আপনাকে একটা form (email etc.) fill করতে হবে। ✅ Approve করলে শুরু করি।

Approve করলে আমি ৩–৪ টার্নে ধাপে ধাপে implement করব (এক টার্নে সব ঢালাও করলে quality নষ্ট হবে)।
