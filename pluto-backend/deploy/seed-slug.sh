#!/usr/bin/env bash
# seed-slug.sh — sandbox worker-এ একটি slug-এর জন্য minimal placeholder bundle
# তৈরি করে on-disk register করে দেয়, যাতে UI থেকে Auto Deploy চালানোর আগেই
# /sites/<slug>/ এবং /site-status/<slug> 200 return করে।
#
# আসল Auto Deploy চললে এই placeholder overwrite হয়ে যাবে (atomic symlink flip)।
#
# Usage:
#   sudo bash deploy/seed-slug.sh <slug>
#   sudo SITES_ROOT=/var/lib/pluto/sites bash deploy/seed-slug.sh dbhstock-8myjt4

set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "✗ run as root (sudo)"; exit 2; }

SLUG="${1:-${SLUG:-}}"
[ -n "$SLUG" ] || { echo "Usage: sudo bash deploy/seed-slug.sh <slug>"; exit 2; }

SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
WSROOT="${SITES_ROOT}/${SLUG}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
REL="seed-${TS}"
RELDIR="${WSROOT}/${REL}"

echo "▶ seeding ${WSROOT}"
install -d -o www-data -g www-data -m 0755 "$SITES_ROOT"
install -d -o www-data -g www-data -m 0755 "$WSROOT"
install -d -o www-data -g www-data -m 0755 "$RELDIR"

cat > "${RELDIR}/index.html" <<HTML
<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${SLUG} — placeholder</title>
<style>
  body{font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:2rem;background:#0b1220;color:#e6edf7}
  .box{max-width:640px;margin:10vh auto;background:#111a2e;padding:2rem;border-radius:12px;box-shadow:0 8px 32px #0006}
  h1{margin:0 0 .5rem;font-size:1.5rem}
  code{background:#1c2740;padding:.15rem .4rem;border-radius:4px}
  .muted{opacity:.7}
</style></head>
<body><div class="box">
  <h1>✓ Sandbox is live</h1>
  <p>Slug: <code>${SLUG}</code></p>
  <p class="muted">This is a placeholder served by <code>pluto-sandbox-worker</code>. Run <b>Auto Deploy</b> from the dashboard to replace it with your real build.</p>
  <p class="muted">Seeded: ${TS}</p>
</div></body></html>
HTML

cat > "${RELDIR}/env.js" <<'JS'
window.__PLUTO_ENV__ = window.__PLUTO_ENV__ || {};
JS

# Manifest — matches shape written by /unpack handler.
cat > "${WSROOT}/current.json" <<JSON
{
  "workspaceId": "${SLUG}",
  "slug": "${SLUG}",
  "channel": "production",
  "release": "${REL}",
  "servedAt": "${TS}",
  "sizeBytes": $(stat -c %s "${RELDIR}/index.html"),
  "placeholder": true
}
JSON
cp "${WSROOT}/current.json" "${WSROOT}/preview.json"

# Atomic symlink flip for `current` and `preview`.
ln -sfn "${REL}" "${WSROOT}/current"
ln -sfn "${REL}" "${WSROOT}/preview"

chown -R www-data:www-data "$WSROOT"

echo "▶ probing worker"
sleep 1
PORT="${PORT:-8787}"
for path in "/site-status/${SLUG}" "/sites/${SLUG}/"; do
  code=$(curl -s -o /tmp/_seed_probe -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}${path}" || echo 000)
  echo "  http://127.0.0.1:${PORT}${path} → HTTP ${code}"
  if [ "$path" = "/site-status/${SLUG}" ] && [ "$code" != "200" ]; then
    echo "  response: $(cat /tmp/_seed_probe)"
  fi
done

echo
echo "✓ seeded slug '${SLUG}' at ${WSROOT}"
echo "  disk state:"
ls -la "$WSROOT"
echo
echo "Next: verify via HTTPS —"
echo "  bash deploy/verify-deploy.sh ${SLUG}"
echo "  then browse: https://api.timescard.cloud/sites/${SLUG}/"
echo
echo "যখন UI থেকে Auto Deploy চালাবেন, worker /unpack call করে এই placeholder-কে"
echo "আসল build দিয়ে atomic symlink flip-এ replace করে দেবে।"
