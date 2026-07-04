
# Pluto — Remaining Gap Closure Plan (Supabase Parity → GA)

আমি কোডবেস স্ক্যান করে দেখলাম কোনগুলো ইতিমধ্যে আছে vs. আপনার তালিকার কোনগুলো এখনো বাকি। নিচে **status + phased delivery plan**।

## Status snapshot (আপনার list vs. codebase)

Legend: ✅ shipped · 🟡 partial (কাজ করে কিন্তু আরো লাগবে) · ❌ missing

### 1. Auth
- ✅ Password reset (`auth_completion` + `auth.reset-password.tsx`), Email confirm, Phone OTP, SMTP + Mailpit e2e
- 🟡 OAuth: generic OIDC + Google আছে — GitHub/Apple/Discord/Facebook/Twitter/LinkedIn/Azure ❌
- 🟡 JWT key rotation table (`kms_key_versions`) আছে — UI + auto-rollover cron ❌
- ❌ Anonymous sign-in (+ link-to-permanent)
- ❌ Auth hooks (before_signin / after_signup — pluggable webhooks)
- 🟡 Rate limit middleware আছে — per-endpoint policy config UI ❌ (env-based only)
- ❌ Magic link (passwordless email login — reset flow ≠ magic link)

### 2. Storage
- 🟡 `storage_ext` + `image-transform.ts` + `0031_storage_transforms_tus.sql` আছে — resize/webp pipeline production-ready? ❌ actual imgproxy wiring
- 🟡 TUS migration আছে — endpoint implementation + client test ❌
- ❌ CDN edge cache + purge API
- ❌ ClamAV/antivirus scan hook
- ❌ Multipart >5GB
- ❌ Presigned POST policies (currently signed GET/PUT only)

### 3. Realtime
- 🟡 `cdc` module + `0032_cdc.sql` আছে — logical replication → channel bridge ❌
- ❌ RLS-aware channel authorization
- ❌ Message replay / persistent channels
- ❌ Redis/NATS backplane for horizontal scale

### 4. Data / API
- ✅ Auto REST + GraphQL (`data_api`), introspection, OpenAPI, RLS
- ❌ Embedded relations (`select=posts(*,author(*))`)
- ❌ Database Webhooks (row change → HTTP)
- ❌ Foreign data wrappers
- ❌ Read-replica routing

### 5. Edge Functions
- ✅ v3 isolate + deployments + invocations table
- 🟡 Deno/V8 — currently `isolate-worker.js` (Node vm). Real Deno runtime ❌
- ✅ Secrets injection (v2 secrets)
- ❌ Warm pool / cold-start optimization
- 🟡 Cron: `pg_cron` used internally — user-facing schedule UI ❌
- ❌ Fn-to-fn invocation + streaming responses

### 6. Observability
- 🟡 Metrics samples + `pluto_http_*` series — proper Prometheus `/metrics` scrape endpoint ✅ (added earlier). OTLP export ❌
- ❌ Distributed tracing (OTel spans → collector)
- ❌ Slow-query analyzer + `EXPLAIN` capture
- ❌ Error grouping (fingerprint/occurrence/assignee)
- 🟡 Alerts webhook table আছে — rules engine + PagerDuty/Slack/Discord routing ❌

### 7. Database DX
- ✅ SQL editor route
- ❌ Airtable-style table editor
- ❌ ERD / schema visualizer
- 🟡 Saved queries via `sql_history` — sharing ❌
- ❌ RLS policy builder UI
- ❌ Extension marketplace
- 🟡 RBAC roles — DB-role management UI ❌

### 8. Billing / Multitenancy
- ✅ Stripe webhooks, plans, enforcement middleware, tests
- ❌ Usage-based billing + invoicing
- ❌ Overage + auto-suspend
- ❌ Cost estimation dry-run
- ❌ Per-workspace resource isolation (quotas partial via `quotas_snapshots`)

### 9. Compliance
- 🟡 GDPR delete requests table, KMS versions, data residency — workflow endpoints + purge job ❌
- ❌ User data export ZIP
- ❌ IP allowlist per workspace
- ❌ Field-level encryption
- ❌ Pentest tracker + SAST/dep-scan CI

### 10. Backup / DR
- ✅ PITR drill, WAL config, replicas, restore CI
- ❌ Streaming WAL to object store on schedule (config exists, worker ❌)
- ❌ Customer-managed KMS for backup encryption
- ❌ Weekly automated restore-to-scratch validation job

### 11. SDKs / Ecosystem
- ✅ TS, Python, Go skeletons
- ❌ Rust, Swift, Kotlin, Flutter
- ✅ CLI skeleton — `migrations`, `functions deploy`, `secrets` commands ❌
- ❌ `pluto start` local Docker compose one-shot
- ❌ VS Code / JetBrains extensions
- ❌ Next/Nuxt/SvelteKit/Expo starter templates

### 12. Dashboard UX
- ✅ Command palette, workspace switcher, RBAC page
- ❌ Onboarding checklist
- ❌ In-app support/feedback widget
- ❌ Per-endpoint API playground (Swagger try-it-now)

### 13. Docs / Community
- 🟡 `docs/api/*` কিছু pages — full docs site ❌
- ❌ Interactive tutorials
- ✅ OpenAPI snapshot → auto reference (partial)
- ✅ `status.tsx` page — public status.io-style ❌
- ❌ Changelog / RSS

### 14. Integrations directory
- ❌ Vercel/Netlify/Cloudflare deploy hooks
- ❌ Zapier/Make/n8n
- ❌ Airbyte/Fivetran sources
- ❌ PostHog/Segment/Mixpanel forwarders

---

## Phased delivery (10 phases, ~ordered by user-impact + dependency)

### Phase 41 — Auth completeness
- Anonymous sign-in + link-to-permanent
- Magic link email (reuse Mailpit pipeline)
- GitHub + Apple + Discord + Facebook + Azure OAuth adapters
- Auth hooks: `before_signin` / `after_signup` webhook config table + dispatcher
- JWT signing-key rotation UI (`dashboard.settings` tab) + weekly cron rollover
- Per-endpoint rate-limit policy table + admin UI

### Phase 42 — Storage production
- Real imgproxy sidecar + signed transform URLs
- TUS endpoint (create/patch/head) with resumable state in `storage_uploads`
- Presigned POST with conditions (content-type, max-size)
- Multipart >5GB (S3-compatible part upload)
- ClamAV scan queue + quarantine bucket
- CDN cache-purge admin endpoint

### Phase 43 — Realtime CDC + scale
- `wal2json`/logical slot → NATS → channel bridge worker
- RLS-aware channel authorization (evaluate policies on subscribe)
- Persistent channels + replay from `realtime_messages`
- NATS backplane for horizontal presence

### Phase 44 — Data API depth
- Embedded relations parser (`select=a,b(*,c(*))`)
- Database Webhooks (trigger + `pg_net`-style HTTP dispatcher)
- Foreign data wrapper admin (postgres_fdw + credentials)
- Read-replica router (write=primary, read=replica pool)

### Phase 45 — Edge functions v4
- Swap Node vm → Deno Deploy-compatible isolate (Deno subprocess pool OR Cloudflare `workerd`)
- Warm-pool manager (min-instances per fn)
- Cron scheduling UI over `pg_cron`
- Fn-to-fn invocation + streaming SSE responses

### Phase 46 — Observability depth
- OTel tracing (fastify plugin → OTLP → Tempo/Jaeger)
- Slow-query capture (`pg_stat_statements` scraper) + EXPLAIN store
- Error grouping module (fingerprint via stack hash, occurrence table)
- Alert rules engine (threshold DSL → dispatchers: Slack/Discord/PagerDuty/webhook)

### Phase 47 — Database DX
- Spreadsheet table editor route (`dashboard.editor.tsx`)
- ERD SVG generator from `information_schema.foreign_keys`
- RLS policy builder wizard
- Extension marketplace (allow-listed CREATE EXTENSION)
- DB roles/permissions UI

### Phase 48 — Billing + Multitenancy production
- Usage-based metering → Stripe usage records
- Invoicing + hosted invoice link
- Overage + auto-suspend workflow
- Cost dry-run endpoint (`POST /billing/estimate` with query/AI token counts)
- Per-workspace pg role + connection-pool isolation

### Phase 49 — Compliance + DR hardening
- Right-to-delete worker (cascading purge on schedule)
- User data export ZIP generator
- IP allowlist per workspace (middleware)
- Field-level encryption helpers (pgcrypto wrapper)
- SAST + `npm audit` in CI, findings tracker table
- Streaming WAL archiver worker + weekly restore-to-scratch job + customer KMS

### Phase 50 — Ecosystem + Docs + Integrations
- SDKs: Rust, Swift, Kotlin, Flutter (generated from OpenAPI)
- `pluto` CLI: `login`, `migrations`, `functions deploy`, `secrets`, `start` (docker compose)
- VS Code extension (schema browser + RLS linter)
- Framework starters (Next/Nuxt/SvelteKit/Expo)
- Full docs site (`/docs/*` MDX) + interactive tutorials + changelog RSS
- Public status page (uptime pings + incident timeline)
- Integrations: Vercel/Netlify deploy hooks, Zapier/n8n, PostHog/Segment forwarders, Airbyte source

---

## Technical notes
- প্রতিটি phase-এ: migration + module + tests + dashboard page + docs update — বর্তমান pattern maintained।
- Phase order dependency-driven: 45 (edge) depends on 41 (auth hooks) for secure invocation; 48 (billing) depends on 46 (metrics) for usage records; 50 (SDKs) depends on stable OpenAPI snapshot (already shipped)।
- Estimated: 1 phase ≈ 1 focused build session (multiple turns)।

কোন phase দিয়ে শুরু করব সেটা বলুন — আমি সাধারণত **Phase 41 (Auth completeness)** সবচেয়ে উচ্চ-ROI সুপারিশ করি, কারণ এটাই সবচেয়ে বেশি user-facing blocker।
