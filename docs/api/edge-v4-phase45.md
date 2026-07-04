# Edge Runtime v4 — Phase 45

Deno-subhosting parity: multi-file bundles, `npm:` / `https:` imports with
integrity pinning, per-function secrets, deployments/rollback API, custom
domains, and cron schedules.

## Enable

```
PLUTO_ENABLE_EDGE_V4=1
```

## Deployments — `/fn/v4/deployments`

```
POST /fn/v4/deployments
{
  "slug": "orders",
  "entry": "index.ts",
  "files": {
    "index.ts": "export default async (req) => new Response('hi')",
    "lib/util.ts": "export const x = 1"
  },
  "imports": {
    "lodash": "npm:lodash@4.17.21",
    "sha256": "https://esm.sh/js-sha256@0.11.0"
  },
  "env":         { "STAGE": "prod" },
  "timeout_ms":  5000,
  "memory_mb":   128,
  "allow_hosts": ["api.example.com"],
  "traffic_pct": 100,
  "activate":    true
}
```

Response includes the resolved import URLs and SRI `sha384` integrity for every specifier so the deployment is byte-reproducible.

- `POST /fn/v4/deployments/:id/activate` — flips traffic to this version (optional `traffic_pct` for canary).
- `POST /fn/v4/deployments/:id/rollback` — marks inactive; previous version becomes reachable via `/activate`.

## Secrets — `/fn/v4/secrets`

Per-function or workspace-wide (`slug: null`). Ciphertext stored via AES-GCM
(same key derivation as TOTP/OIDC secrets). Values are **never** returned.

```
PUT    /fn/v4/secrets   { "slug": "orders", "name": "STRIPE_SK", "value": "sk_…" }
GET    /fn/v4/secrets?slug=orders     -> names only
DELETE /fn/v4/secrets   { "slug": "orders", "name": "STRIPE_SK" }
```

Secrets are injected into `ctx.env` at invoke time, with per-fn secrets
overriding workspace-wide ones of the same name.

## Imports — `/fn/v4/imports`

`resolveImport()` fetches from esm.sh (for `npm:`) or the given `https:` URL,
computes a `sha384` integrity, and caches the resolution in `fn_v4_imports`.
Re-deploys with the same specifier are a no-op cache hit.

Bare specifiers (`import x from "lodash"`) are rejected — use `npm:lodash@4.17.21` or `https://…`.

## Custom Domains — `/fn/v4/domains`

Register `hostname → slug` for parity with Supabase function domains:

```
POST /fn/v4/domains { "hostname": "api.acme.com", "slug": "gateway", "path_prefix": "/" }
```

Wire the hostname to your ingress/CDN — the router matches `hostname + path_prefix` to the deployment.

## Cron — `/fn/v4/cron`

Unix-cron subset (`*`, ranges, lists, `*/n`):

```
POST /fn/v4/cron { "slug": "nightly-report", "cron_expr": "0 3 * * *" }
POST /fn/v4/cron/tick     — admin: run all due schedules right now
```

The dispatcher recomputes `next_run_at` after each fire. Run the sweeper from `pg_cron` every minute:

```sql
select cron.schedule('edge-v4-tick', '* * * * *',
  $$select net.http_post(url := 'http://localhost:8080/fn/v4/cron/tick',
                         headers := jsonb_build_object('apikey', current_setting('pluto.service_role')));$$);
```

## Invoke — `/fn/v4/invoke/:slug`

`ALL` verbs. Loads the active deployment, decrypts secrets, injects them plus resolved imports into `ctx`, and runs the entry file in the hardened isolate from Phase 35 (no `eval`, no WASM, worker-per-invocation with heap cap + deadline).

Logs: `GET /fn/v4/logs?slug=…&limit=100` — includes `triggered_by` (`http|cron|domain`) and sanitised request headers.
