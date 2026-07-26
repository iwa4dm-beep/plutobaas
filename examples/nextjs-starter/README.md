# Pluto BaaS — Next.js E2E Starter

Small Next.js 14 (App Router) starter to exercise Pluto BaaS **Auth**, **RLS**,
and **Webhooks** end-to-end. Companion to `docs/GUIDE-FULLSTACK-E2E.md`.

## What it verifies

1. **Auth** — Email/password sign-up + sign-in against `POST /auth/v1/token`.
2. **RLS** — Signed-in user can insert/read only their own `notes` row.
3. **Webhooks** — A Pluto webhook (DB event or Ops) posts to
   `/api/webhooks/pluto` and the handler verifies the HMAC signature.

## Quick start

```bash
cd examples/nextjs-starter
cp .env.example .env.local
bash ../../scripts/setup-starter.sh local        # or: docker | cloud
npm install
npm run dev            # http://localhost:3000
```

Apply `setup.sql` (from `examples/lovable-frontend/setup.sql`) to your Pluto
project first — it creates the `notes` table, RLS policies, and grants.

## E2E test

```bash
npm run test:e2e        # runs tests/e2e.spec.ts against http://localhost:3000
```

The same script runs in CI — see `.github/workflows/starter-e2e.yml`.

## Layout

```
app/
  layout.tsx
  page.tsx               # auth + notes demo
  api/webhooks/pluto/route.ts   # HMAC-verified webhook receiver
lib/
  pluto.ts               # tiny fetch-based Pluto client
tests/
  e2e.spec.ts            # Playwright script hitting local dev server
.env.example
package.json
```
