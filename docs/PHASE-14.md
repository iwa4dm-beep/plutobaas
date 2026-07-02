# Phase 14 — CLI & Communications

Phase 14 tackles two long-requested surfaces that unlock day-to-day
developer + product workflows on top of the Pluto core:

1. **`pluto` CLI** — a single binary for local dev + CI:
   `pluto init`, `pluto login`, `pluto migrations new/status/apply/rollback`,
   `pluto sql`, `pluto functions deploy`, `pluto workspaces list/create`,
   `pluto keys rotate`, `pluto secrets set/list`.
2. **Communications module** — first-class Email (SMTP + provider adapters
   for Resend/SES/Postmark), outbound Webhooks with retry/HMAC, and a
   pluggable SMS gateway (Twilio/MessageBird), all governed by workspace RLS
   and audit-logged.

## Deliverables (this phase)

- `backend/apps/cli/` — TypeScript Node CLI, `bun`-built single file.
  Auth via device flow → stores tokens in `~/.pluto/config.json` (0600).
- `backend/apps/server/src/modules/comms/` — Fastify plugin exposing:
  - `POST /comms/v1/email/send`
  - `POST /comms/v1/sms/send`
  - `POST /comms/v1/webhooks` (CRUD + `test`)
  - `POST /comms/v1/webhooks/:id/deliveries/:deliveryId/retry`
- New tables (migration `0014_comms.sql`):
  `comms_email_messages`, `comms_sms_messages`,
  `comms_webhooks`, `comms_webhook_deliveries`.
  All workspace-scoped, RLS-guarded, audit-hooked.
- SDK additions in `src/lib/pluto/live.ts`:
  `live.email.send(...)`, `live.sms.send(...)`, `live.webhooks.{list,create,test,deliveries,retry}`.
- Dashboard pages: `/dashboard/comms/email`, `/dashboard/comms/webhooks`,
  `/dashboard/comms/sms` with delivery timelines, retry buttons, and
  live delivery streams over `system:comms`.

## Non-goals for Phase 14

- Rich template engine — v14 ships plaintext + Handlebars-lite variable
  substitution; Phase 15 introduces MJML + versioned templates.
- SMS inbound (2-way) — Phase 15.
- Push notifications (APNs / FCM) — Phase 15.

## Runtime + provider config

Providers are chosen per workspace via `settings.comms.*`:

```
comms.email.driver      = "smtp" | "resend" | "ses" | "postmark"
comms.email.from        = "noreply@example.com"
comms.email.smtp.*      = host / port / user / pass / secure
comms.sms.driver        = "twilio" | "messagebird" | "log"
comms.webhooks.timeout_ms = 10000
comms.webhooks.max_retries = 8      # exponential backoff, capped at 24h
```

Secrets live in the encrypted `service_settings` table and never leak into
audit metadata.

## Security

- Every send is authorized against `has_role(auth.uid(), 'admin')` OR a
  workspace member role that carries the `comms.send` scope.
- Webhook secrets are hashed at rest and only shown once at creation
  (like API keys). Signature: `X-Pluto-Signature: t=<ts>,v1=<hmac>`.
- Outbound HTTP is rate-limited per workspace + per destination host to
  prevent SSRF-style amplification. Private IP ranges are blocked unless
  the workspace has `comms.allow_private_targets = true`.

## Milestones

- **14.0** — this document + skeleton files (current commit).
- **14.1** — DB migration + module scaffold, SMTP driver, admin routes,
  audit + RLS tests.
- **14.2** — Webhooks with retry queue on top of the existing `pluto_jobs`
  role.
- **14.3** — Twilio SMS driver + rate limiting.
- **14.4** — CLI first release with migrations + sql + workspaces.
- **14.5** — Dashboard UI (three pages) wired to the new SDK.
