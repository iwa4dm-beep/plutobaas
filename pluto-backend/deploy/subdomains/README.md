# Multi-Subdomain HTTPS Setup (app / api / dashboard)

This bundle sets up clean HTTPS for three subdomains without server_name /
certificate conflicts, and verifies each one automatically before deploy
finishes.

## Files

| file | purpose |
|---|---|
| `nginx-subdomain.conf.template` | Parameterized nginx server block (HTTP→HTTPS redirect + HTTPS vhost). |
| `render-nginx.sh` | Renders the template for `app`, `api`, `dashboard` into `/etc/nginx/sites-available/` and symlinks into `sites-enabled/`. |
| `issue-certs.sh` | Runs certbot in `--nginx` mode for all three subdomains, then `nginx -t && systemctl reload nginx`. Idempotent — safe to re-run. |
| `verify-https.sh` | Probes `https://<host>/` on each subdomain, checks HTTP 200/3xx, and verifies the served certificate CN / SAN matches the expected host. Exits non-zero if any check fails — call this at the end of your deploy pipeline. |
| `install-all.sh` | One-command wrapper: render → issue → verify. |

## One-command install (as root on the VPS)

```bash
sudo BASE_DOMAIN=timescard.cloud \
     APP_UPSTREAM=static \
     API_UPSTREAM=http://127.0.0.1:3000 \
     DASHBOARD_UPSTREAM=http://127.0.0.1:8080 \
     LETSENCRYPT_EMAIL=you@example.com \
     bash pluto-backend/deploy/subdomains/install-all.sh
```

After it finishes you should see:

```
✓ https://app.timescard.cloud       200  CN=app.timescard.cloud
✓ https://api.timescard.cloud       200  CN=api.timescard.cloud
✓ https://dashboard.timescard.cloud 200  CN=dashboard.timescard.cloud
```

## Design notes

- **No `server_name` conflicts** — each subdomain gets its own file in
  `sites-available/`, one `server{}` for :80 (redirect) and one for :443.
- **No certificate mix-up** — every :443 block references its own
  `/etc/letsencrypt/live/<host>/fullchain.pem`; certbot per-host issuance
  keeps them isolated.
- **HTTP → HTTPS redirect** is enforced on all three subdomains.
- **ACME challenge path** (`/.well-known/acme-challenge/`) is served over
  HTTP so renewals never break.
- `verify-https.sh` is safe to wire into CI or a post-deploy step; it uses
  `openssl s_client` to read the actual certificate, not just trust the
  chain.
