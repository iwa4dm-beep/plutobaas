# Phase 50 — Auth v3 (WebAuthn/passkeys · TOTP · Risk · Devices)

Enable with `PLUTO_ENABLE_AUTH_V3=1`. Optional env:
- `PLUTO_WEBAUTHN_RP_ID` (default `localhost`)
- `PLUTO_WEBAUTHN_RP_NAME` (default `Pluto BaaS`)

## Endpoints (base `/auth/v3`)

### Passkeys / WebAuthn
- `POST /passkeys/register/options` → mints challenge, stores it (`purpose=register`, 2m TTL).
- `POST /passkeys/register/verify` → `{ challenge, credential_id, public_key_b64, transports?, aaguid?, friendly_name? }`.
- `POST /passkeys/authenticate/options` → returns `allowCredentials` for the user.
- `POST /passkeys/authenticate/verify` → `{ challenge, credential_id, sign_count }`. Rejects counter regression (clone detection).
- `GET  /passkeys` / `DELETE /passkeys/:id`.

### TOTP MFA
- `POST /totp/enroll` → `{ factor_id, secret, otpauth_url }` (render as QR).
- `POST /totp/verify` → activates factor. Uses ±1 step window (RFC 6238).
- `POST /totp/challenge` → step-up for verified factor; returns `{ step_up_ok: true }`.
- `DELETE /totp/:id` → status → `revoked`.
- `POST /recovery-codes/generate` → 10 single-use codes (returned once, stored as sha256 hashes).
- `POST /recovery-codes/consume` → one-shot; also acts as step-up.

### Session risk + devices
- `POST /sessions/score` — send `{ signals, device_hash?, ip? }`, receive `{ score, band, step_up_required, reasons[] }`. Persists an `av3_sessions` row.
- `GET /devices` / `PATCH /devices/:id` (`label`, `trusted`) / `DELETE /devices/:id` (revokes device + cascades to sessions).
- `GET /sessions` / `DELETE /sessions/:id`.

## Risk model
| Signal | Points |
|---|---|
| new_device | +25 |
| new_network (different /24) | +10 |
| new_country | +25 |
| impossible_travel | +40 |
| tor_or_vpn | +15 |
| ≥5 failed attempts / 15m | +20 |
| 2–4 failed attempts / 15m | +5 |

Bands: `low <30`, `medium 30–59`, `high ≥60`. Step-up required for medium & high.

## Tables (migration `0048_phase50_auth_v3.sql`)
`av3_webauthn_credentials`, `av3_webauthn_challenges`, `av3_totp_factors`,
`av3_recovery_codes`, `av3_devices`, `av3_sessions`. All RLS-enabled;
grants to `authenticated` + `service_role`.
