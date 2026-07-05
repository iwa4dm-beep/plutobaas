# Production Deploy Guide — Pluto Backend on VPS

Target: `api.timescard.cloud` on `72.62.67.83` (Ubuntu-like VPS as root).
Run each block on the VPS in order. Every step is idempotent.

---

## 0. Prep

```bash
apt update && apt install -y ufw nginx certbot python3-certbot-nginx jq curl
cd ~/backend-joy/pluto-backend && git pull
```

---

## 1. Firewall (UFW)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp          # SSH
ufw allow 80/tcp          # HTTP (ACME + redirect)
ufw allow 443/tcp         # HTTPS
ufw --force enable
ufw status verbose
```

Postgres/Redis/MinIO/API stay bound to `127.0.0.1` inside docker compose — they
are never exposed to the internet directly. Nginx is the only public surface.

---

## 2. DNS

At your registrar, create:

| Type | Host | Value           | TTL |
| ---- | ---- | --------------- | --- |
| A    | api  | 72.62.67.83     | 300 |

Verify:

```bash
dig +short api.timescard.cloud       # should print 72.62.67.83
```

---

## 3. Rotate default secrets (CRITICAL — do BEFORE going public)

```bash
cd ~/backend-joy/pluto-backend
bash deploy/rotate-secrets.sh .env
# Follow the printed post-steps (ALTER USER, restart, MinIO re-init).
```

---

## 4. Nginx + HTTPS

```bash
mkdir -p /var/www/certbot
cp deploy/nginx/api.timescard.cloud.conf /etc/nginx/sites-available/api.timescard.cloud
ln -sf /etc/nginx/sites-available/api.timescard.cloud /etc/nginx/sites-enabled/api.timescard.cloud
rm -f /etc/nginx/sites-enabled/default

# Temporarily comment out the two ssl_certificate lines so nginx can start
# BEFORE the cert exists (certbot needs :80 to serve the ACME challenge).
sed -i 's|^\(\s*ssl_certificate.*\)|# \1|' /etc/nginx/sites-available/api.timescard.cloud
nginx -t && systemctl reload nginx

# Obtain cert
certbot --nginx -d api.timescard.cloud --agree-tos -m admin@timescard.cloud -n --redirect

# Re-enable the explicit ssl_certificate lines (certbot may have inlined them
# differently — if `nginx -t` passes, you can leave certbot's version).
nginx -t && systemctl reload nginx

# Cert auto-renew is installed by certbot as a systemd timer:
systemctl list-timers | grep certbot
```

Confirm:

```bash
curl -sI https://api.timescard.cloud/livez | head -5
```

---

## 5. systemd auto-start

```bash
cp deploy/systemd/pluto-backend.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now pluto-backend.service
systemctl status pluto-backend.service --no-pager
```

Now the whole docker-compose stack comes up automatically on reboot.

Reboot drill (do this once):

```bash
reboot
# after it comes back:
docker compose --env-file .env -f docker/docker-compose.yml ps
curl -s https://api.timescard.cloud/livez
```

---

## 6. Uptime monitoring

Free option — cron every 2 minutes, alerts on failure:

```bash
cp deploy/uptime-check.sh /usr/local/bin/pluto-uptime.sh
chmod +x /usr/local/bin/pluto-uptime.sh
touch /var/log/pluto-health.log

crontab -l 2>/dev/null | { cat; echo '*/2 * * * * /usr/local/bin/pluto-uptime.sh || echo "PLUTO DOWN" | mail -s "pluto-backend down" you@example.com'; } | crontab -
```

Or point an external monitor (UptimeRobot, BetterStack, Cronitor) at:

- `https://api.timescard.cloud/livez` — process alive
- `https://api.timescard.cloud/readyz` — deps reachable
- `https://api.timescard.cloud/health/deps` — postgres + s3 detail
- `https://api.timescard.cloud/health/migrations` — schema/FK integrity

---

## 7. Backups verification

```bash
ls -lh /var/lib/pluto/backups | tail -5
# Manual dump to prove the path works:
docker compose --env-file .env -f docker/docker-compose.yml exec postgres \
  pg_dump -U pluto -d pluto -Fc -f /tmp/manual.dump
docker compose --env-file .env -f docker/docker-compose.yml cp \
  postgres:/tmp/manual.dump /var/lib/pluto/backups/manual-$(date -u +%FT%H%M).dump
```

Then schedule a nightly pg_dump via cron (add to root crontab):

```
15 3 * * *  cd /root/backend-joy/pluto-backend && docker compose --env-file .env -f docker/docker-compose.yml exec -T postgres pg_dump -U pluto -d pluto -Fc > /var/lib/pluto/backups/nightly-$(date -u +\%F).dump && find /var/lib/pluto/backups -name 'nightly-*.dump' -mtime +14 -delete
```

---

## 8. End-to-end smoke test

```bash
BASE=https://api.timescard.cloud
curl -s $BASE/livez | jq
curl -s $BASE/readyz | jq
curl -s $BASE/health/deps | jq
curl -s $BASE/health/migrations | jq '.status, .audit_log_fk'
```

All four should return `"status":"ok"`.

---

## Done — production checklist

- [x] Firewall closes everything except 22/80/443
- [x] DNS points at VPS
- [x] All default secrets rotated
- [x] Nginx + Let's Encrypt HTTPS with HSTS
- [x] systemd auto-starts stack on reboot
- [x] Uptime probe on all 4 health endpoints
- [x] Nightly pg_dump with 14-day retention
- [x] `/health/migrations` reports `audit_log_fk.ok = true`
