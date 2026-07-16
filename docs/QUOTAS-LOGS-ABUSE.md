# Phase F — Quotas, Logs, Abuse Controls

Turns the wildcard host into a metered, rate-limited surface with a data
trail per project.

## What ships in this phase

```
pluto-backend/
├── migrations/0037_project_usage_and_quotas.sql
├── deploy/
│   ├── parse-nginx-logs.sh                       # 5-min log roll-up
│   ├── nginx/pluto-slug-logging.conf             # log_format + limit_req_zone
│   └── systemd/
│       ├── pluto-usage-parser.service
│       └── pluto-usage-parser.timer
└── (wildcard-app.conf patched to emit the log + apply the limit)
```

## Data model

| table                          | populated by             | read by                     |
|--------------------------------|--------------------------|-----------------------------|
| `admin.project_usage`          | `parse-nginx-logs.sh`    | dashboard usage panel       |
| `admin.project_quotas`         | operators (`sql`) or UI  | quota-enforcement job       |
| `admin.quota_defaults` (row 1) | migration seed           | falls back for missing rows |
| `admin.abuse_events`           | `parse-nginx-logs.sh`    | dashboard "issues" pane     |
| `admin.project_usage_current_month` (view) | ↑              | dashboard summary tiles     |

RLS lets any workspace member read rows for slugs their workspace owns
(joined via `public.workspaces.slug`). All writes are service-role.

## Traffic accounting

Nginx wildcard-app writes JSON lines to `/var/log/nginx/pluto-slugs.log`:

```json
{"ts":"2026-07-16T12:34:56+00:00","slug":"acme","channel":"current",
 "host":"acme.app.timescard.cloud","remote":"1.2.3.4","method":"GET",
 "uri":"/","status":200,"bytes_sent":4213,"body_bytes_sent":3990,
 "rt":0.012,"ua":"...","ref":"..."}
```

`parse-nginx-logs.sh` runs every 5 minutes, tails from the last offset
(inode-aware, survives `logrotate`), aggregates per (slug, day), and
POSTs to `/admin/v1/project-usage/upsert`. Spikes above configurable
thresholds emit rows to `admin.abuse_events`.

## Rate limiting

`limit_req_zone $binary_remote_addr$pluto_ws_slug zone=pluto_slug_rps:16m rate=20r/s;`
plus `limit_req zone=pluto_slug_rps burst=40 nodelay;` — one bucket per
(client IP, slug), so a hot tenant can't starve the neighbors.

Overrides in `admin.project_quotas` (`rate_limit_rps`, `rate_limit_burst`)
are the source of truth; wiring those into nginx via a reconciled
per-slug `map` is a small follow-up (out of scope for this migration —
default rate covers 99% of workloads).

## Install

```bash
# 1. Migrate
pnpm --filter migrator run migrate

# 2. Nginx: drop the log format + zone into conf.d, patch wildcard vhost
sudo cp pluto-backend/deploy/nginx/pluto-slug-logging.conf \
        /etc/nginx/conf.d/
sudo cp pluto-backend/deploy/nginx/wildcard-app.conf \
        /etc/nginx/sites-available/wildcard-app.timescard.cloud.conf
sudo nginx -t && sudo systemctl reload nginx

# 3. Log dir permissions (parser runs as `pluto`)
sudo install -d -o pluto -g adm /var/lib/pluto/parser
sudo usermod -aG adm pluto            # /var/log/nginx group=adm on Debian/Ubuntu

# 4. Deploy parser + timer
sudo install -m 0755 pluto-backend/deploy/parse-nginx-logs.sh \
        /opt/pluto/deploy/
sudo cp pluto-backend/deploy/systemd/pluto-usage-parser.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now pluto-usage-parser.timer

# 5. Verify
sudo systemctl list-timers pluto-usage-parser.timer
psql -c "select * from admin.project_usage_current_month order by requests desc limit 10;"
```

## Backend API contract

Two service-role endpoints the parser calls:

- `POST /admin/v1/project-usage/upsert`  
  Body: `{ "rows": [{ slug, day, requests, bytes_out, errors_4xx, errors_5xx }] }`  
  Behavior: `INSERT ... ON CONFLICT (slug, day) DO UPDATE SET requests = excluded.requests + project_usage.requests, ...` (SUM-merge; do NOT overwrite — parser only reports incremental deltas since last offset).
- `POST /admin/v1/abuse-events`  
  Body: `{ slug, kind, detail }` → append to `admin.abuse_events`.

Both require `Bearer $PLUTO_SERVICE_ROLE_KEY`. If these routes don't
exist in the Pluto API yet, add them alongside the existing
`/admin/v1/domains` handlers.

## Dashboard integration

`src/routes/dashboard.usage.tsx` already exists as a placeholder — wire
it to select from `admin.project_usage_current_month` filtered by the
active workspace's slug. Sample query:

```sql
select slug, requests, bytes_out, errors_5xx,
       request_limit, bytes_limit, suspended
from admin.project_usage_current_month
where slug = $1;
```

Abuse events list, keyed by workspace:

```sql
select kind, detail, observed_at
from admin.abuse_events
where slug = $1
order by observed_at desc
limit 50;
```
