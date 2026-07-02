# Phase 15 — Advanced Auth (MFA · SSO · Templates · Push)

Phase 15 closes the biggest remaining gap between Pluto and hosted BaaS
competitors: everything a real product needs *around* the raw
`auth/v1/token` flow.

## Scope

1. **MFA (TOTP)** — enroll authenticator app, verify enrollment, challenge
   on sign-in, generate one-time recovery codes.
2. **SSO** — generic OIDC + SAML 2.0 providers per workspace (Okta,
   Entra ID, Google Workspace, JumpCloud, Auth0…). Managed OIDC via the
   `openid-client` pattern; SAML via a lightweight assertion consumer.
3. **Email/SMS templates** — versioned, workspace-scoped, Handlebars-lite
   variable substitution; used by the auth flows (magic link, password
   reset, verification) and by the Communications module.
4. **Push notifications** — device token registry + `push.send` to APNs
   (HTTP/2 with JWT) and FCM (HTTP v1). Same delivery ledger + retry as
   Comms webhooks.

## Deliverables

- Migration `0015_advanced_auth.sql`:
  - `auth_mfa_factors`         — one row per enrolled factor (secret encrypted).
  - `auth_mfa_challenges`      — short-lived challenges to bind /login pairs.
  - `auth_recovery_codes`      — hashed, single-use.
  - `auth_sso_providers`       — per-workspace OIDC/SAML config.
  - `auth_sso_sessions`        — nonce/state tracking for the redirect dance.
  - `comms_templates`          — versioned templates (email/sms/push).
  - `push_devices`             — registered device tokens.
  - `push_messages`            — outbound push ledger, mirrors comms tables.
- Server modules:
  - `modules/advanced_auth/`   — MFA + SSO + Push routes, gated by
    `PLUTO_ENABLE_ADVANCED_AUTH=1`.
  - `modules/templates/`       — CRUD + preview + variable linter.
- SDK: `live.auth.mfa.*`, `live.auth.sso.*`, `live.push.*`,
  `live.templates.*`.
- Dashboard: `/dashboard/mfa` (enrolled devices + recovery codes),
  `/dashboard/sso` (provider setup wizard),
  `/dashboard/templates` (versioned editor with preview).

## Milestones

- **15.0** — this document + skeleton files + migration (current commit).
- **15.1** — TOTP enroll / verify / challenge, recovery codes.
- **15.2** — OIDC provider (Google Workspace + Okta tested), state store.
- **15.3** — SAML 2.0 SP-initiated flow.
- **15.4** — Template CRUD + variable linter + preview.
- **15.5** — Push registry + APNs + FCM v1 drivers.

## Security notes

- MFA secrets are AES-256-GCM encrypted at rest with the same key derivation
  as `service_settings` (`PLUTO_SETTINGS_KEY`); ciphertext never leaves the
  server and never appears in audit metadata.
- Recovery codes are stored as `argon2id` hashes; users see them exactly
  once, right after enrollment.
- SAML assertions require signed responses; unsigned responses are rejected.
- Push tokens are workspace-scoped; a token registered against workspace A
  cannot be targeted from workspace B, even with the service role key.
