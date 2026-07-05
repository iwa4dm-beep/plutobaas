# External Uptime Monitoring

The API exposes health endpoints for external probes:

| Endpoint | Interval | Alert on |
|---|---|---|
| `https://api.timescard.cloud/livez` | 1–2 min | non-200 for 2 checks |
| `https://api.timescard.cloud/readyz` | 5 min | non-200 for 2 checks |
| `https://api.timescard.cloud/health/migrations` | 15 min | non-200 |

## Option 1 — UptimeRobot (free, recommended)

1. Sign up at https://uptimerobot.com (free tier: 50 monitors, 5 min interval)
2. **+ Add New Monitor** → Type: **HTTP(s)**
3. Configure each endpoint from the table above
4. Alert Contacts: add your email / SMS / Slack / Discord webhook
5. Save. Notifications fire when the endpoint is down for ≥2 consecutive checks.

## Option 2 — BetterStack / Healthchecks.io

Same procedure; both offer free tiers with 1-minute intervals and richer status pages.

## Option 3 — Self-hosted cron probe (already installed)

`deploy/uptime-check.sh` runs via cron on the VPS itself and logs to
`/var/log/pluto-health.log`. Only useful as a secondary check — an external
monitor is required because a VPS-local probe cannot detect a total VPS outage.

```bash
crontab -l | grep uptime-check   # verify it's scheduled
```
