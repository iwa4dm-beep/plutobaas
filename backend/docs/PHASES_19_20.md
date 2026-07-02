# Phase 19 & 20 — Developer Experience + Enterprise

Both phases ship dark by default. Toggle with env flags:

```
PLUTO_ENABLE_DEVEX=1       # Phase 19: templates, PATs, webhooks, plugins
PLUTO_ENABLE_ENTERPRISE=1  # Phase 20: IP rules, custom domains, regions, status
```

Apply the SQL migrations `0019_devex.sql` and `0020_enterprise.sql`
(handled automatically by `boot.sh`).

## Phase 19 — Developer Experience & Ecosystem

| Surface | Route | Notes |
| --- | --- | --- |
| Project templates | `GET/POST /devex/v1/templates` | Public read for `published=true`; admin write. |
| Personal access tokens | `POST /devex/v1/tokens` | Returns raw token once, stores sha256. |
| Webhooks | `POST /devex/v1/webhooks` | HMAC-SHA256 signed via `x-pluto-signature`. |
| Webhook test ping | `POST /devex/v1/webhooks/:id/test` | Records delivery attempt. |
| Plugin registry | `GET/POST /devex/v1/plugins` | Per-workspace extension catalog. |

Consumers verify webhook deliveries as:

```ts
const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig.replace("sha256=", "")))) reject();
```

## Phase 20 — Enterprise & Multi-region

| Surface | Route | Notes |
| --- | --- | --- |
| IP allow/deny | `GET/POST /enterprise/v1/ip-rules` | Deny wins; allow-list defaults to deny-others. |
| Forward-auth probe | `POST /enterprise/v1/ip-rules/check` | Returns 200/403 for Caddy `forward_auth`. |
| Custom domains | `POST /enterprise/v1/domains` | Returns DNS TXT challenge. |
| Verify domain | `POST /enterprise/v1/domains/:id/verify` | Resolves `_pluto-verify.<host>` TXT. |
| Region routing | `GET/PUT /enterprise/v1/regions` | Primary + read-replica hints. |
| Status page | `GET /enterprise/v1/status` | Public JSON for status UIs. |
| Incident feed | `POST /enterprise/v1/status/incidents` | Admin-only; syncs component status. |

### Caddy forward-auth snippet

```
@blocked forward_auth pluto:8787 {
  uri /enterprise/v1/ip-rules/check
  method POST
  header_up Content-Type "application/json"
  request_body {"workspace_id":"{http.request.header.X-Workspace-Id}","ip":"{http.request.remote.host}"}
}
handle @blocked { respond 403 }
```

Both modules keep every write workspace-scoped and RLS-guarded; disabling
the flag makes the routes 404, keeping the surface area minimal by default.
