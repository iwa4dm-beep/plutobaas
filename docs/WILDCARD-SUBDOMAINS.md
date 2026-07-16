# Wildcard Subdomain Hosting — Phase A + B

Every workspace slug becomes `<slug>.app.timescard.cloud` — like
`myapp.lovable.app` or `myapp.vercel.app`. This document is the operator
runbook: DNS, TLS, nginx, and the sandbox-worker changes needed to make
it work end to end.

---

## 1. DNS (one-time, at your registrar / DNS host)

Add two records for the apex you want to use (default `app.timescard.cloud`):

| Type | Name                          | Value          | TTL  |
| ---- | ----------------------------- | -------------- | ---- |
| A    | `app.timescard.cloud`         | `<VPS_IP>`     | Auto |
| A    | `*.app.timescard.cloud`       | `<VPS_IP>`     | Auto |

Verify: `dig +short random-slug.app.timescard.cloud` must return `<VPS_IP>`.

If you use Cloudflare, keep the wildcard record **DNS-only** (grey cloud)
during TLS issuance. You can turn on the orange cloud after Let's Encrypt
has issued the cert.

---

## 2. Wildcard TLS (Let's Encrypt DNS-01)

Wildcards require DNS-01. We ship a script that uses the Cloudflare plugin
by default; any other DNS provider is supported via `FORCE_MANUAL=1`.

```bash
# Cloudflare (recommended):
echo 'dns_cloudflare_api_token = <TOKEN>' | sudo tee /etc/letsencrypt/cloudflare.ini
sudo chmod 600 /etc/letsencrypt/cloudflare.ini
sudo bash pluto-backend/deploy/install-wildcard-tls.sh app.timescard.cloud

# Any provider (interactive TXT record entry):
sudo FORCE_MANUAL=1 bash pluto-backend/deploy/install-wildcard-tls.sh app.timescard.cloud
```

Renewal is automatic (`certbot.timer`). Verify with
`sudo certbot renew --dry-run`.

---

## 3. Install the wildcard nginx site

```bash
sudo cp pluto-backend/deploy/nginx/wildcard-app.conf \
        /etc/nginx/sites-available/wildcard-app.timescard.cloud.conf
sudo ln -sf /etc/nginx/sites-available/wildcard-app.timescard.cloud.conf \
            /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The config does the routing itself:

```nginx
map $host $pluto_ws_slug {
    "~^(?<slug>[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?)\.app\.timescard\.cloud$" $slug;
}
server {
    root /var/lib/pluto/sites/$pluto_ws_slug/current;
    ...
}
```

Any `<slug>.app.timescard.cloud` request → nginx serves
`/var/lib/pluto/sites/<slug>/current/` (a symlink written by the
sandbox-worker after each deploy).

---

## 4. Sandbox-worker v2 — slug-aware deploys

The worker now accepts either identifier:

```jsonc
POST /unpack
{
  "workspaceId": "02504262-b997-408d-bdc7-f50c3066238b",  // legacy, still works
  "slug":        "myapp",                                 // NEW — preferred
  "bucket":      "deploys",
  "key":         "…/bundle.zip"
}
```

On success the worker:

1. Unpacks into `/var/lib/pluto/sites/<workspaceId>/release-…/`.
2. Flips `.../<workspaceId>/current` (atomic symlink).
3. **Also** creates `/var/lib/pluto/sites/<slug>` → `<workspaceId>` symlink,
   so nginx can resolve `<slug>.app.timescard.cloud` without knowing IDs.

New helper: `GET /resolve/:slug` returns `{ workspaceId, current, servedAt }`
so the dashboard can show live-deploy status per subdomain.

---

## 5. Database — slug hardening (migration 0034)

Applied automatically by the migrator. Adds:

- `CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$')` on `admin.workspaces`.
- `admin.reserved_slugs` table + trigger — blocks `api`, `app`, `www`, `admin`, `lovable`, etc.
- `admin.workspace_slug_history` — rename audit; enables 301 redirects from
  old subdomains later (Phase E).

Frontend mirrors the same rules via `src/lib/pluto/reserved-slugs.ts` —
`checkSlug(input)` returns `{ ok, reason }` and `coerceSlug(input)`
normalises `onChange`.

---

## 6. End-to-end verification

```bash
# 1. Wildcard TLS is valid
curl -sI https://random123.app.timescard.cloud | head -1
# → HTTP/2 404  (no bundle yet — nginx served @not_deployed page)

# 2. Deploy a bundle for slug=demo
curl -sS -X POST http://127.0.0.1:8787/unpack \
  -H "x-sandbox-secret: $PLUTO_SANDBOX_SECRET" \
  -H "content-type: application/json" \
  -d '{"workspaceId":"<UUID>","slug":"demo","bucket":"deploys","key":"path.zip"}'

# 3. Site is live
curl -sI https://demo.app.timescard.cloud | head -1
# → HTTP/2 200

# 4. Resolver
curl -sS http://127.0.0.1:8787/resolve/demo \
  -H "x-sandbox-secret: $PLUTO_SANDBOX_SECRET"
# → { "ok": true, "workspaceId": "…", "servedAt": "…" }
```

If step 3 returns the "Not deployed yet" HTML: the symlink didn't get
created — check `journalctl -u pluto-sandbox -f` and confirm
`/var/lib/pluto/sites/demo` is a symlink pointing at the workspace dir.

---

## 7. Frontend env

Add to `.env` (frontend) so the dashboard can render preview URLs:

```
VITE_PLUTO_APP_HOST=app.timescard.cloud
```

Every project row in **Dashboard → Projects** now shows its live
`https://<slug>.<APP_HOST>` link.

---

## What's not in Phase A + B (comes later)

- **Phase C** — auto backend attach: per-project anon/service keys injected
  into the deployed bundle via `/env.js`.
- **Phase D** — custom-domain auto-wire (`custom_domains` → nginx reconcile).
- **Phase E** — `<slug>-dev.app.timescard.cloud` preview vs published split.
- **Phase F** — per-slug quotas, logs, rate limits.
