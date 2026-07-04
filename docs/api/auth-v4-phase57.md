# Phase 57 — Auth v4 (SAML SSO enterprise · SCIM v2 provisioning · session isolation)

Enabled with `PLUTO_ENABLE_AUTH_V4=1`. Mounted at `/auth/v4`.

## Capability scope

| Capability                 | Endpoint(s)                                   | Auth              | Notes                                   |
| -------------------------- | --------------------------------------------- | ----------------- | --------------------------------------- |
| Upload/replace IdP         | `POST /auth/v4/saml/providers`                | apikey + `x-role: admin` | Validates entityID, SSO URL, X509 cert  |
| List IdPs                  | `GET  /auth/v4/saml/providers`                | apikey            | Signing secret never returned           |
| Delete IdP                 | `DELETE /auth/v4/saml/providers/:slug`        | apikey + admin    |                                         |
| Assertion Consumer Service | `POST /auth/v4/saml/:slug/acs`                | apikey            | HMAC-signed test signer; mints session  |
| SCIM users CRUD/PATCH      | `/auth/v4/scim/v2/Users(/id)`                 | apikey (writes → admin) | SCIM 2.0 filter subset: userName, externalId |
| SCIM groups CRUD/PATCH     | `/auth/v4/scim/v2/Groups(/id)`                | apikey (writes → admin) | Member add/remove via PATCH             |
| Resolve session            | `GET  /auth/v4/session/resolve`               | apikey + `x-session-id` | Enforces (session, workspace) binding   |
| Revoke session             | `POST /auth/v4/session/revoke`                | apikey + admin    |                                         |
| Audit stream               | `GET  /auth/v4/audit/events?limit=`           | apikey            | Per-workspace auth + admin events       |

All mutations require `x-role: admin`. All calls scope to `x-workspace-id`
(falls back to the API key's own workspace).

## SAML metadata

The uploader accepts a subset of SAML 2.0 metadata XML: `entityID`, one
`SingleSignOnService` with the HTTP-POST binding, and one
`<X509Certificate>`. Missing pieces return `400 { error: "missing_*" }`.

Assertion format (test signer): `base64url(JSON(assertion)).HMAC_SHA256`.
Production deployments swap this for `xml-crypto`-signed XML; the
`saml.ts` module exports `signAssertion` / `verifyAssertion` so the
plugin surface is unchanged.

Assertion fields:

```json
{
  "issuer": "https://idp.example.com/e",
  "subject_email": "u@example.com",
  "audience": "https://app.example.com",
  "not_before": 1751600000000,
  "not_after":  1751603600000
}
```

Failure modes on `POST /saml/:slug/acs`:

| Reason              | Status | `error`               |
| ------------------- | ------ | --------------------- |
| Unknown provider    | 404    | `unknown_provider`    |
| Malformed assertion | 401    | `malformed_assertion` |
| Bad signature       | 401    | `bad_signature`       |
| Expired / not yet valid | 401 | `expired` / `not_yet_valid` |
| Audience mismatch   | 401    | `audience_mismatch`   |

Success returns `{ ok: true, session_id, expires_at }`; the session is
bound to `(workspace_id, subject_email)`.

## SCIM v2

Supports: `Users` and `Groups` collections; `POST` (create),
`GET` (list + get, filter `userName eq "..."`, `externalId eq "..."`,
pagination via `startIndex` + `count`); `PUT` (replace); `PATCH`
(RFC 7644 subset: `replace active`, `replace displayName`,
`add emails`, `remove members[value eq "..."]`); `DELETE`.

De-provision by `PATCH` with `{ op: "replace", path: "active", value: false }`
(soft) or `DELETE /Users/:id` (hard; cascades to group memberships).

Uniqueness is enforced per `(workspace_id, userName)`; duplicates return
`409 { error: "user_exists" }`.

## Session isolation policy

Every mutating downstream call is expected to resolve the caller's
session against the requested workspace via `GET /auth/v4/session/resolve`
(`x-session-id` header). The policy rejects:

- `unknown_session` — session id doesn't exist
- `revoked` — session was explicitly revoked
- `expired` — past `expires_at`
- `wrong_workspace` — session was minted for a different workspace_id

Every denial writes a `session.reuse_denied` (or `session.resolve/denied`)
row to the audit stream, visible via `GET /auth/v4/audit/events`.

`admin` vs `member` is checked with `checkAdmin(session_id, ws)` — it
returns `not_admin` and logs `admin.check/denied` for member sessions.

## Audit stream

`GET /auth/v4/audit/events?limit=100` returns recent events for the
caller's workspace, newest first. Actions include:

- `session.create`, `session.resolve`, `session.reuse_denied`, `session.revoke`
- `admin.check`, `admin.header_check`
- `saml.provider_upsert`, `saml.acs`
- `scim.user_create`, `scim.user_patch`, `scim.user_replace`, `scim.user_delete`

## Feature flag

Set `PLUTO_ENABLE_AUTH_V4=1` on the server. The plugin is a no-op when
disabled so untested deployments incur zero surface area.
