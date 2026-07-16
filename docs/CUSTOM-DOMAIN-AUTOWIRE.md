# Phase D — Custom Domain Auto-Wire

Bring-your-own-domain flow for Pluto projects:
`customer.com → https://<slug>.app.timescard.cloud`, fully automated cert
issuance + nginx reload driven by a reconciler daemon.

## Architecture

```
Dashboard (custom-domains.tsx)
      │
      ▼
POST /enterprise/v1/domains         ← user adds hostname
      │  (Pluto API stores row, verified=false)
      ▼
User adds TXT _lovable=…            ← DNS proof
      │
      ▼
POST /enterprise/v1/domains/:id/verify
      │  (API sets verified=true, nginx_state='pending')
      ▼
┌───────────────────────────────────────────────┐
│  pluto-domain-reconciler.timer  (every 2 min) │
│    → GET /admin/v1/domains?reconcile=1        │
│    → for each row:                            │
│        certbot --nginx -d <host>              │
│        render /etc/nginx/sites-available/…    │
│        systemctl reload nginx                 │
│        PATCH nginx_state=live                 │
└───────────────────────────────────────────────┘
      │
      ▼
Traffic on customer.com → /var/lib/pluto/sites/<slug>/current
                          (sandbox-worker managed symlink)
```

## Database (migration `0036`)

Adds these columns to `enterprise.custom_domains`:

| column                | purpose                                             |
|-----------------------|-----------------------------------------------------|
| `target_workspace_id` | which workspace owns the domain                     |
| `target_slug`         | which subdomain project root to serve               |
| `nginx_state`         | `pending / issuing / live / failed / removing`      |
| `last_reconciled_at`  | wall-clock of last successful pass                  |
| `cert_expires_at`     | mirrored from Let's Encrypt for renewal telemetry   |
| `cert_last_error`     | surfaced back into the dashboard `last_error` field |
| `reconcile_attempts`  | backoff counter                                     |
| `next_retry_at`       | earliest allowed next attempt                       |

The migration is idempotent and no-ops if `enterprise.custom_domains` is
absent (e.g. dev DB without the enterprise schema).

## Files delivered in this phase

```
pluto-backend/
├── migrations/0036_custom_domain_reconciler.sql
├── deploy/
│   ├── reconcile-domains.sh                       # cron/systemd body
│   ├── nginx/custom-domain.conf.template          # per-host vhost
│   └── systemd/
│       ├── pluto-domain-reconciler.service
│       └── pluto-domain-reconciler.timer
```

## Install (operator runbook)

```bash
# 1. Migrate schema
pnpm --filter migrator run migrate           # applies 0036

# 2. Copy binaries into /opt/pluto (mirrors repo layout)
sudo mkdir -p /opt/pluto/deploy/nginx /opt/pluto/deploy/systemd
sudo cp pluto-backend/deploy/reconcile-domains.sh          /opt/pluto/deploy/
sudo cp pluto-backend/deploy/nginx/custom-domain.conf.template \
        /opt/pluto/deploy/nginx/
sudo chmod +x /opt/pluto/deploy/reconcile-domains.sh

# 3. Environment file (systemd EnvironmentFile)
sudo install -d /etc/pluto
sudo tee /etc/pluto/reconciler.env >/dev/null <<'EOF'
PLUTO_API_BASE=http://127.0.0.1:8000
PLUTO_SERVICE_ROLE_KEY=REPLACE_ME
CERTBOT_EMAIL=ops@timescard.cloud
EOF
sudo chmod 600 /etc/pluto/reconciler.env

# 4. Install + enable the timer
sudo cp pluto-backend/deploy/systemd/pluto-domain-reconciler.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pluto-domain-reconciler.timer

# 5. Watch it work
sudo systemctl list-timers pluto-domain-reconciler.timer
sudo tail -f /var/log/pluto/reconcile-domains.log
```

## Backend API contract (already implemented in `enterprise/v1/domains`)

The reconciler only needs two admin endpoints on top of the existing
enterprise surface. If they don't exist yet, add them:

- `GET /admin/v1/domains?verified=true&reconcile=1`
  Returns `{ domains: [{ id, hostname, target_slug, nginx_state, ... }] }`
  filtered to `verified=true AND (next_retry_at IS NULL OR next_retry_at < now())`
  AND `nginx_state IN ('pending','issuing','failed','live','removing')`.
- `PATCH /admin/v1/domains/:id`
  Accepts `{ nginx_state, cert_last_error, cert_expires_at }` and bumps
  `last_reconciled_at = now()`, `reconcile_attempts` on transitions into
  `failed`, and clears the counter on `live`.

RLS: both endpoints are service-role only. The dashboard already reads
these fields through the existing `enterprise.domains()` query.

## Failure surface

| symptom                              | reconciler action              | dashboard shows              |
|--------------------------------------|--------------------------------|------------------------------|
| DNS not pointing to VPS              | `certbot` returns non-zero     | `failed` + `cert_last_error` |
| Rate-limited by Let's Encrypt        | `certbot` non-zero, retry loop | `failed` + backoff timer     |
| `target_slug` missing                | skip + patch `failed`          | "assign a project first"     |
| nginx config test fails after render | rollback (no reload)           | `failed` + last error        |

## Smoke test

```bash
# On the VPS, run once manually:
DRY_RUN=1 sudo -E /opt/pluto/deploy/reconcile-domains.sh

# Real run (issues cert):
sudo -E /opt/pluto/deploy/reconcile-domains.sh
curl -I https://<your-domain>       # 200 + valid cert
```

Removal: dashboard "Remove domain" flips `nginx_state='removing'`; the
reconciler tears the vhost down and reloads nginx within one tick.
