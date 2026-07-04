# Phase 41 — Auth completeness

Adds the last-mile Supabase-parity pieces to `/auth/v1/*`.

## New endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/v1/magic-link` | Email a one-time passwordless sign-in link (15 min TTL). Always returns 200 (no user enumeration). |
| GET  | `/auth/v1/magic-link/verify?token=…&redirect_to=…` | Consume the token, issue a session. Redirects with `#access_token=…` when `redirect_to` is provided. |
| POST | `/auth/v1/anonymous` | Provisions a guest user + session (`is_anonymous: true`). |
| POST | `/auth/v1/link-anonymous` | Auth required. Converts the current guest to a permanent email/password account. |

## New OAuth providers

`GET /auth/v1/oauth/{google|github|apple|discord|facebook|azure|linkedin}` — configure via env pairs:

```
APPLE_CLIENT_ID / APPLE_CLIENT_SECRET
DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET
FACEBOOK_CLIENT_ID / FACEBOOK_CLIENT_SECRET
AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET
```

## Auth hooks (webhooks)

Register hooks in `public.auth_hooks`:

| Column | Notes |
| --- | --- |
| `event` | `before_signin`, `after_signin`, `before_signup`, `after_signup`, `before_password_reset`, `after_password_reset`, `after_magic_link`, `after_anonymous_signin` |
| `target_url` | Receives `POST` with JSON `{ event, ...payload, ts }` |
| `secret` | Optional; when set, sends `x-pluto-signature: sha256=<hmac>` |
| `timeout_ms` | Default 3000 |

`before_*` hooks may veto by returning `{ "allow": false, "reason": "…" }` → caller receives `403 hook_denied`. Every delivery is recorded in `public.auth_hook_deliveries` for audit.

## Per-endpoint rate-limit policies

`public.rate_limit_policies` — admin-configurable, seeded with safe defaults for `/auth/v1/*`, `/rest/v1/*`, `/functions/v1/*`, `/graphql/v1`. Scope one of `ip | user | token | ip_email`. The middleware in `lib/ratelimit-mw.ts` reads this table on hot-reload.

## Env flags

- `PLUTO_ENABLE_AUTH_PHASE41` (default `1`)
- `PLUTO_APP_URL` — used to build magic-link URLs when the request lacks `X-Forwarded-*`
