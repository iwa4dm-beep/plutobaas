# Auto Backend Attach — Phase C

**Goal:** Each project on `<slug>.app.timescard.cloud` gets a live Pluto
backend (DB / Auth / Storage / Functions) without extra work — exactly
like Lovable Cloud "just working" on a new project.

Phase C is the plumbing that makes Phase A+B's wildcard subdomain
actually run a functional app.

---

## Architecture

```text
    ┌───────────────────────┐          ┌────────────────────────┐
    │  Dashboard (this repo)│          │  Pluto API (VPS)       │
    │  ─────────────────    │          │  admin.project_env     │
    │  Env & Secrets vault  │──REST───▶│  admin.project_secrets │
    └───────────┬───────────┘          └──────────┬─────────────┘
                │                                 │
                │ POST /unpack {env}              │ read on deploy
                ▼                                 ▼
    ┌───────────────────────┐          ┌────────────────────────┐
    │  Sandbox-worker (VPS) │          │  <slug>/current/env.js │
    │  writes env.js        │─────────▶│  window.__PLUTO_ENV__  │
    └───────────────────────┘          └──────────┬─────────────┘
                                                  │
                                                  ▼
                                      ┌────────────────────────┐
                                      │ createClientAuto()     │
                                      │ (from @pluto/js)       │
                                      └────────────────────────┘
```

**No key ever lives in the built bundle.** The same static ZIP can be
deployed to 100 projects; each gets its own `env.js` at unpack time.

---

## What ships in Phase C

| Piece | Location | Purpose |
| ----- | -------- | ------- |
| Migration `0035` | `pluto-backend/migrations/0035_project_env_and_secrets.sql` | Two tables (`project_env` public, `project_secrets` encrypted) + owner RLS + `project_runtime_env()` helper |
| Sandbox-worker v3 | `pluto-backend/sandbox-worker/sandbox-worker.mjs` | Accepts `env` in `/unpack`, writes `env.js` before flip; `POST /env` for hot rotation without redeploy |
| SDK `createClientAuto` | `pluto-backend/packages/sdk-js/src/index.ts` | Prefers `window.__PLUTO_ENV__` — one bundle, many tenants |
| Dashboard `live.ts` fallback | `src/lib/pluto/live.ts` | Reads runtime env first (matters for embedded admin apps) |
| Env & Secrets UI | `src/routes/dashboard.projects.$slug.env.tsx` | Public env editor + reveal-once secret vault |

---

## 1. Public runtime env (`admin.project_env`)

Owner-editable, browser-visible. Rendered into `/env.js` at deploy:

```js
// /var/lib/pluto/sites/<slug>/current/env.js
window.__PLUTO_ENV__ = {
  url: "https://api.timescard.cloud",
  anonKey: "pk_anon_...",
  // any PLUTO_URL / FEATURE_FLAG / PUBLIC_ANALYTICS_ID etc.
};
```

`index.html` in the deployed bundle must load this **before** the app
script:

```html
<script src="/env.js"></script>
<script type="module" src="/assets/index.js"></script>
```

Rules enforced in the migration:
- Keys match `^[A-Z][A-Z0-9_]{0,62}$`.
- **Never** put a service_role key / DB password / OAuth secret here — this
  file is trivially inspectable in DevTools. Use the Secret Vault instead.

## 2. Secret vault (`admin.project_secrets`)

Encrypted at rest with AES-256-GCM. Only readable by service_role from
edge functions / server routes:

```sql
select value_ciphertext from admin.project_secrets where project_id = ...;
-- decrypt in code using APP_USER_CONNECTION_KEY_SECRET-style key
```

Semantics:
- Plaintext is shown **once**, when created or rotated. After that only
  metadata (`name`, `hint`, `rotated_at`) is available to owners.
- `rotate` mints a new plaintext, replaces the ciphertext, bumps
  `rotated_at`. Old value is unrecoverable.
- `delete` removes the row immediately — deployed functions lose access
  next call.

## 3. Sandbox-worker `/unpack` contract (v3)

```jsonc
POST /unpack
{
  "workspaceId": "…",
  "slug": "myapp",
  "bucket": "deploys",
  "key": "…/bundle.zip",
  "env": {                       // NEW — merged into env.js
    "url":       "https://api.timescard.cloud",
    "anonKey":   "pk_anon_…",
    "PROJECT_ID":"…"
  }
}
```

The worker writes `env.js` **inside the new release directory** before
the atomic symlink flip, so switching to a new bundle also switches its
env — no window where old bundle sees new env or vice versa.

Rotate env without redeploying:

```
POST /env
{ "slug": "myapp", "env": { "anonKey": "pk_anon_NEW_..." } }
```

The worker rewrites `current/env.js` in-place. Browsers pick it up on
next page load (the config file is served `no-store`).

## 4. SDK usage in a deployed frontend

```ts
// src/lib/pluto.ts inside any user project deployed to <slug>.app.timescard.cloud
import { createClientAuto } from "@pluto/js";

// No URL / key here — read from window.__PLUTO_ENV__ at runtime.
export const pluto = createClientAuto();
```

For local dev you can pass a fallback:

```ts
export const pluto = createClientAuto({
  url: import.meta.env.VITE_PLUTO_URL,
  apiKey: import.meta.env.VITE_PLUTO_ANON_KEY,
});
```

## 5. Backend endpoints (implement in `packages/api`)

The dashboard UI calls (contract only — implement server-side to match):

```
GET    /admin/v1/projects/:slug/env
PUT    /admin/v1/projects/:slug/env/:key    body: { value }
DELETE /admin/v1/projects/:slug/env/:key

GET    /admin/v1/projects/:slug/secrets                  → metadata only
POST   /admin/v1/projects/:slug/secrets                  body: { name, value } → { name, plaintext }
POST   /admin/v1/projects/:slug/secrets/:name/rotate     → { name, plaintext }
DELETE /admin/v1/projects/:slug/secrets/:name
```

All routes require the workspace-owner JWT; the vault write endpoints
also verify `has_role('admin')` before touching `service_role`.

## 6. End-to-end smoke test

```bash
# 1. Set a public env var
curl -sS -X PUT https://api.timescard.cloud/admin/v1/projects/demo/env/PLUTO_URL \
  -H "authorization: Bearer $OWNER_JWT" -H "content-type: application/json" \
  -d '{"value":"https://api.timescard.cloud"}'

# 2. Redeploy the bundle (worker will emit env.js from the DB)
curl -sS -X POST http://127.0.0.1:8787/unpack \
  -H "x-sandbox-secret: $PLUTO_SANDBOX_SECRET" \
  -H "content-type: application/json" \
  -d '{"workspaceId":"…","slug":"demo","bucket":"deploys","key":"…","env":{"url":"https://api.timescard.cloud","anonKey":"pk_anon_…"}}'

# 3. Verify env.js is served
curl -sS https://demo.app.timescard.cloud/env.js
# → window.__PLUTO_ENV__ = {"url":"https://api.timescard.cloud","anonKey":"pk_anon_…"};

# 4. In the deployed app's DevTools console:
window.__PLUTO_ENV__  // {url: "...", anonKey: "..."}
```

---

## Not in Phase C

- Auto-provisioning a per-project Postgres schema on create — the current
  `signup-full` flow already does workspace + project + keys atomically;
  richer per-project isolation (namespaced schemas, storage buckets,
  function slots) is Phase C-next.
- Custom-domain wiring: Phase D.
- Preview vs published env split: Phase E.
