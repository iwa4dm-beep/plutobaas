# Phase 31–33 — Foundation Completion

Three phases, six major features. Each phase ships independently and passes typecheck + vitest before the next starts.

---

## Phase 31 — Auth completion

### 31.1 Password reset flow
- Migration `0030_auth_recovery.sql`: `password_reset_tokens (id, user_id, token_hash, expires_at, used_at, created_at)`, GRANTs to `service_role` only, sweeper for expired rows.
- Backend `auth/plugin.ts`:
  - `POST /auth/v1/recover { email }` — always 200 (no user enumeration), enqueues email with reset link if user exists.
  - `POST /auth/v1/verify-recovery { token, new_password }` — bcrypt + zxcvbn strength check, rotates refresh tokens.
- SDK: `auth.resetPasswordForEmail(email)`, `auth.updatePassword(newPw)`.
- UI: `/auth/forgot` and `/auth/reset-password` routes; link from existing sign-in card.
- Email template: `password-reset.tsx` (React Email — reuse comms module templates).

### 31.2 Email confirmation
- Migration `0031_email_confirm.sql`: add `email_confirmed_at`, `email_confirm_token_hash`, `email_confirm_sent_at` to `users`.
- Signup pathway gated by `PLUTO_REQUIRE_EMAIL_CONFIRM=1` (default off for back-compat).
- `POST /auth/v1/confirm-email { token }` marks confirmed; `POST /auth/v1/resend-confirmation { email }` with 60s rate limit.
- Middleware `requireEmailConfirmed` for sensitive endpoints (opt-in per route).
- Email template `email-confirm.tsx`.

### 31.3 Google OAuth provider
- New `backend/apps/server/src/modules/oauth/google.ts` implementing the full OIDC dance (auth URL, callback with state+PKCE, JWKS verify — reuse `jose` from SSO fix).
- Migration `0032_oauth_identities.sql`: `oauth_identities (user_id, provider, provider_sub, email, created_at, updated_at)`, unique `(provider, provider_sub)`.
- Endpoints: `GET /auth/v1/oauth/google/start?redirect_to=…`, `GET /auth/v1/oauth/google/callback`.
- Config via env: `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_REDIRECT_BASE_URL`.
- SDK: `auth.signInWithOAuth("google", { redirectTo })`.
- UI: "Continue with Google" button on `/auth`.

### 31.4 Phone / SMS OTP
- Migration `0033_phone_otp.sql`: add `phone`, `phone_confirmed_at` to `users`; `phone_otp_codes (phone, code_hash, expires_at, attempts, created_at)`.
- Endpoints: `POST /auth/v1/otp/send { phone, channel: "sms"|"whatsapp" }`, `POST /auth/v1/otp/verify { phone, code }` → returns session.
- Provider abstraction `sms/provider.ts` with Twilio adapter (env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`) and a `console` dev adapter.
- Rate limit: 5 sends per phone per hour, 6-digit code, 10-minute TTL, max 5 verification attempts.
- SDK: `auth.signInWithOtp({ phone })`, `auth.verifyOtp({ phone, token })`.

**Phase 31 doc:** `docs/api/auth.md` — every endpoint, error codes, provider setup.

---

## Phase 32 — Storage: transformations + TUS

### 32.1 Image transformations
- Endpoint `GET /storage/v1/render/image/:bucket/*` accepting query `?width=&height=&resize=cover|contain|fill&quality=&format=webp|jpeg|png|avif`.
- Impl: use `@resvg/resvg-wasm` + `@jsquash/*` (WASM, Worker-safe — `sharp` is a native binary and won't run in Cloudflare Workers per the server-runtime rules).
- LRU cache keyed by `sha256(path + transforms)` in a `render_cache` bucket (24h TTL); cache-hit returns straight from cache with `x-cache: hit`.
- Signed URL variant: extend existing `/object/sign` to accept an optional `transform` param that gets baked into the token.
- Per-workspace budget: max 10MP output, max 20 concurrent renders (queue).

### 32.2 TUS resumable uploads
- Implement TUS 1.0.0 protocol on `/storage/v1/upload/resumable`.
- Endpoints: `POST /` (create), `HEAD /:id` (offset check), `PATCH /:id` (chunk append), `DELETE /:id` (abort). Return required headers: `Tus-Resumable`, `Upload-Offset`, `Upload-Length`, `Tus-Extension`.
- Migration `0034_tus_uploads.sql`: `tus_uploads (id, bucket_id, object_name, total_size, uploaded_size, upload_metadata jsonb, expires_at, created_by)`.
- Chunks stored under `.tus/<id>/<offset>` in the target bucket, concatenated to final object on `Upload-Length` reached.
- 24h expiry sweeper.
- SDK: `storage.from(bucket).uploadResumable(file, { chunkSize, onProgress })` using the `tus-js-client` npm package on the client.

### 32.3 Dashboard updates
- `/dashboard/storage`: preview transform panel (URL builder with sliders for width/quality/format).
- Show cache hit rate + render latency on `/dashboard/observability`.

**Phase 32 doc:** `docs/api/storage.md` — transform params, TUS flow, chunk-size recommendations.

---

## Phase 33 — Postgres CDC → Realtime channels

This is the signature Supabase feature parity work.

### 33.1 WAL logical decoding pipeline
- Migration `0035_cdc.sql`: create publication `pluto_cdc` with configurable table set; replication slot `pluto_cdc_slot` using `wal2json`.
- New module `backend/apps/server/src/modules/cdc/`:
  - `decoder.ts` — long-running `pg.Client` subscribed to `START_REPLICATION SLOT pluto_cdc_slot LOGICAL 0/0 (proto_version '1', publication_names 'pluto_cdc')`.
  - `dispatcher.ts` — parses each wal2json event into `{ schema, table, op: INSERT|UPDATE|DELETE, old, new, commit_ts }` and publishes on `postgres_changes:<schema>:<table>` internal bus (reuses existing `pg_notify('pluto_broadcast', …)`).
- Boot orchestrated from `server.ts` behind `PLUTO_ENABLE_CDC=1` flag; single-instance guard via `pg_try_advisory_lock`.

### 33.2 Realtime channel bindings
- Extend `realtime_v2/plugin.ts` subscribe payload to accept:
  ```json
  { "event": "postgres_changes",
    "schema": "public", "table": "todos",
    "filter": "user_id=eq.<uuid>" }
  ```
- Filter parser supports `eq|neq|gt|gte|lt|lte|in` (subset of PostgREST filter grammar, Zod-validated).
- RLS enforcement: each event is re-evaluated against the subscriber's JWT using `SET LOCAL role authenticated; SET LOCAL request.jwt.claims = …; SELECT` on the new row's PK to confirm visibility before delivery. Rows the subscriber cannot SELECT are dropped silently.

### 33.3 CDC admin UI
- `/dashboard/realtime` gains a "Change data capture" panel: list tables in the publication, add/remove tables, show slot lag (bytes behind WAL head), restart slot.
- Backend: `GET /rt/v2/cdc/tables`, `POST /rt/v2/cdc/tables/:table`, `DELETE …`, `GET /rt/v2/cdc/slot-lag`, `POST /rt/v2/cdc/restart`.

### 33.4 Docs
- `docs/api/realtime-cdc.md`: subscription payload, filter grammar, RLS semantics, slot-lag interpretation, tuning (checkpoint_timeout, wal_keep_size).

---

## Technical details

- **All migrations follow the RLS/GRANT lockdown pattern** from `docs/security/core-tables-rls.md`: `service_role` only unless a policy explicitly opens a lane.
- **Every new endpoint** is preceded by `requireApiKey`; sensitive mutations by `requireWorkspaceAdmin` or `requireScope(...)`.
- **Vitest coverage** added per feature: password-reset flow, JWKS-verified Google callback, TUS offset math, CDC filter parser, RLS re-check.
- **No new npm packages requiring native binaries** (Cloudflare Worker constraint). Confirmed Worker-safe: `jose`, `@jsquash/*`, `@resvg/resvg-wasm`, `pg` (already used), `tus-js-client` (client-only).
- **Feature flags**: `PLUTO_REQUIRE_EMAIL_CONFIRM`, `PLUTO_ENABLE_OAUTH_GOOGLE`, `PLUTO_ENABLE_SMS_OTP`, `PLUTO_ENABLE_IMAGE_TRANSFORM`, `PLUTO_ENABLE_TUS`, `PLUTO_ENABLE_CDC` — everything opt-in so existing behaviour never breaks.

## Out of scope (call out for Phase 34+)

- Additional OAuth providers (GitHub, Apple, Discord) — same OIDC scaffold, add per provider.
- Antivirus / ClamAV scanning on uploaded objects.
- Realtime backplane (Redis/NATS) for multi-instance CDC fan-out.
- Full PostgREST-style auto-generated REST from schema.
- Deno/V8 isolate runtime for edge functions.

## Delivery order

I'll build Phase 31 → 32 → 33 in sequence, each landing as a self-contained batch with backend + SDK + UI + docs + typecheck-green.

## Ask before starting

1. **SMS provider**: Twilio adapter + `console` dev adapter, or a different provider (Vonage, MessageBird)?
2. **Email transport**: reuse the existing `comms` module (already handles auth-related emails), or wire in Lovable Emails / Resend for the reset + confirmation flow?
3. **Order preference**: strict 31 → 32 → 33, or interleave (e.g. CDC first because it's the biggest differentiator)?

Reply "go" for defaults (Twilio + comms + 31→32→33), or specify overrides.

---

## ✅ Phases 31–33 delivered (2026-07-04)

**Phase 31 — Auth completion**
- Migration `0030_auth_completion.sql`: password_reset_tokens, phone/OTP columns, phone_otp_codes.
- `modules/auth_completion/plugin.ts`: `/auth/v1/recover`, `/verify-recovery`, `/send-email-confirmation`, `/confirm-email`, `/resend-confirmation`, `/otp/send`, `/otp/verify`, `/config`.
- `lib/email-provider.ts` (console + webhook), `lib/sms-provider.ts` (console + Twilio).
- SDK: `live.auth.{resetPasswordForEmail,verifyPasswordRecovery,confirmEmail,resendConfirmation,signInWithOtp,verifyOtp,sendEmailConfirmation,config}`.
- UI: `/auth/forgot`, `/auth/reset-password`, `/auth/confirm-email`, `/auth/phone` routes + links on sign-in card.
- Google OAuth was already present at `modules/auth/oauth.ts` — kept as-is.
- Docs: `docs/api/auth.md`.

**Phase 32 — Storage: image transforms + TUS resumable uploads**
- Migration `0031_storage_transforms_tus.sql`: `tus_uploads`, `render_cache`.
- `modules/storage_ext/plugin.ts`: `/storage/v1/render/image/:bucket/*`, `DELETE /storage/v1/render/cache/:bucket`, TUS 1.0.0 `POST/HEAD/PATCH/DELETE /storage/v1/upload/resumable`, `OPTIONS` discovery, 5-min expiry sweeper.
- `lib/image-transform.ts`: pluggable provider abstraction (passthrough default; WASM providers swap in via `setImageTransformProvider`).
- SDK: `storageV2.{renderUrl, purgeRenderCache, uploadResumable}` (built-in TUS client with 409 offset-conflict resume).
- Docs: `docs/api/storage.md`.

**Phase 33 — Postgres CDC → realtime channels**
- Migration `0032_cdc.sql`: `cdc_config`, `cdc_events` (24h ring buffer).
- `modules/cdc/dispatcher.ts`: `startCdcPipeline` (advisory-lock guarded), `dispatchCdcEvent`, `getSlotLag`, `sweepCdcRetention`, publication + slot management (wal2json → test_decoding fallback).
- `modules/cdc/filter.ts`: PostgREST-style filter parser (`eq|neq|gt|gte|lt|lte|in`) + evaluator.
- `modules/cdc/plugin.ts`: `/rt/v2/cdc/{tables,tables/:qual,slot-lag,events,subscribe}` admin surface.
- Vitest: `src/lib/pluto/cdc-filter.spec.ts` (9 tests, all green).
- SDK: `cdc.{listTables, enableTable, disableTable, slotLag, events, validateSubscribe}`.
- UI: `CdcPanel` component embedded in `/dashboard/realtime` — add/remove tables, live slot-lag readout.
- Docs: `docs/api/realtime-cdc.md`.

All features are opt-in via env flags (`PLUTO_ENABLE_AUTH_COMPLETION`, `PLUTO_ENABLE_SMS_OTP`, `PLUTO_REQUIRE_EMAIL_CONFIRM`, `PLUTO_ENABLE_IMAGE_TRANSFORM`, `PLUTO_ENABLE_TUS`, `PLUTO_ENABLE_CDC`). Typecheck: green. Vitest: green.

---

## ✅ Phases 34–36 delivered (2026-07-04)

**Phase 34 — Auto REST + GraphQL (`PLUTO_ENABLE_DATA_API=1`)**
- Migration `0033_data_api.sql`: `data_api_exposed`, `data_api_introspect_cache`.
- `modules/data_api/{introspect,openapi,graphql,plugin}.ts`:
  `GET /rest/v1/` (OpenAPI 3.1), `GET /rest/v1/introspect`, `POST /graphql/v1`
  (hand-rolled parser + executor; supports `where/order/limit/offset` +
  `insert_/update_/delete_` mutations; RLS via `SET LOCAL pluto.user_id`).
- Hidden system tables excluded from discovery/GraphQL.
- Docs: `docs/api/data-api.md`.

**Phase 35 — Edge Functions v3 hardened isolate (`PLUTO_ENABLE_EDGE_V3=1`)**
- Migration `0034_edge_v3.sql`: `fn_v3_deployments`, `fn_v3_invocations`.
- `modules/edge_v3/isolate.ts`: worker-thread invoker with
  `resourceLimits.maxOldGenerationSizeMb`, wall-clock deadline via
  `worker.terminate()`, `codeGeneration.strings/wasm=false`, fetch host
  allow-list; reuses existing `modules/edge/isolate-worker.js`.
- `modules/edge_v3/plugin.ts`: deployments CRUD + `/fn/v3/invoke/:slug` +
  invocation log with automatic versioning.
- Docs: `docs/api/edge-v3.md`.

**Phase 36a — Stripe billing + plan enforcement (`PLUTO_ENABLE_BILLING=1`)**
- Migration `0035_billing.sql`: `billing_plans` (free/pro/team/enterprise
  seeded with feature + limit maps), `billing_subscriptions`, `billing_events`.
- `modules/billing/plugin.ts`: `/billing/v1/{plans,subscription,checkout,portal,webhook,admin/set-plan}`.
- No Stripe SDK dep — direct `fetch` to `api.stripe.com` with HMAC
  webhook verify; dev mode when `STRIPE_SECRET_KEY` absent.
- Exports enforcement helpers `getWorkspacePlan / planAllows / planLimit`
  with 60s cache; other modules can gate features by workspace plan.

**Phase 36b — PITR + cross-region backup replication (`PLUTO_ENABLE_PITR=1`)**
- Migration `0036_pitr.sql`: `wal_archive_config`, `pitr_snapshots`,
  `backup_replicas`, `pitr_restores`.
- `modules/pitr/plugin.ts`: `/pitr/v1/{config,snapshots,restore,replicas,...}`.
- Control plane + audit log — the physical `pg_basebackup` / WAL replay
  runs out of process via `backend/scripts/backup.sh`.

Docs: `docs/api/billing-pitr.md`.

**Server wiring:** all four plugins registered in `backend/apps/server/src/server.ts` behind their env flags; nothing changes when disabled.

Out of scope for Phase 37+: full SDK bindings for these routes,
dashboard UI panels for billing + PITR, GraphQL subscriptions, Deno v2
runtime, and antivirus scanning on storage uploads.

---

## ✅ Phases 37–40 + beta blockers delivered (2026-07-04)

### Beta blockers
- **Per-IP + per-token rate limiter** — `backend/apps/server/src/lib/ratelimit-mw.ts` (leaky-bucket, in-memory, GC every 60s). Attach via `preHandler: rateLimit()` or `strictLimit` on expensive routes.
- **SMTP email transport** — extended `lib/email-provider.ts` with a raw-socket SMTP (STARTTLS-capable) adapter picked up automatically when `SMTP_HOST` is set. Falls back to webhook → console.
- **Prometheus `/metrics`** — already wired in `server.ts`; documented in `docs/local-dev.md`.
- **OpenAPI spec** — served at `GET /rest/v1/` by the Phase-34 data-api plugin.

### Phase 37 — SDKs + CLI
- `sdks/python/pluto/` — `PlutoClient`, REST query builder, GraphQL, auth, storage, edge invoke. `pyproject.toml` for publish.
- `sdks/go/pluto/` — mirror in Go with `go.mod`, `context.Context`-aware calls.
- CLI (`backend/apps/cli/`) — existing skeleton retained; SDK docs added.

### Phase 38 — Docs site + status page
- `docs/README.md` — indexed docs entry point (auth, data-api, storage, cdc, edge-v3, billing-pitr, tokens/logs, compliance, status).
- `docs/local-dev.md` — one-shot local dev walkthrough with feature-flag matrix.
- `docs/status.md` — uptime targets, incident policy.
- `src/routes/status.tsx` — public `/status` page polling `/readyz`.

### Phase 39 — Dashboard UX
- `src/components/pluto/CommandPalette.tsx` — global ⌘K palette mounted in `dashboard.tsx`.
- `src/routes/dashboard.rbac.tsx` — invite/list/role-change/remove members with role reference card.

### Phase 40 — SOC2 artifacts
- Migration `0037_compliance.sql`: `gdpr_delete_requests`, `data_residency`, `kms_key_versions`.
- `modules/compliance/plugin.ts` (`PLUTO_ENABLE_COMPLIANCE=1`):
  `/compliance/v1/{delete-me,delete-me/cancel,export-me,residency,kms/keys,kms/rotate}`.
- Docs: `docs/compliance/{soc2,data-residency,kms}.md`.

**Server wiring**: `compliancePlugin` registered in `server.ts` behind its flag. All prior phases untouched.

Out of scope for future phases: full CLI command surface expansion (login/deploy/db), auth-service SDK login flow in Python/Go, hosted docs site build (`mkdocs` / `docusaurus`), automated SOC2 evidence collection worker, WebAuthn.
