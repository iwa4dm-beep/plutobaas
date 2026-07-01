#!/usr/bin/env bash
# Deploy Pluto to a VPS / cloud host using docker-compose.prod.yml + Caddy.
# Usage:  ./scripts/deploy-cloud.sh
#
# Prereqs on the target host:
#   - docker + docker compose plugin
#   - DNS A record pointing DOMAIN at this host
#   - .env populated (start from .env.cloud.example, then run gen-secrets.sh)
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "!! .env not found. Copy .env.cloud.example to .env and fill it in."
  exit 1
fi

# Sanity-check critical secrets are not placeholders
missing=0
for var in DOMAIN JWT_SECRET ANON_KEY SERVICE_ROLE_KEY POSTGRES_PASSWORD; do
  val="$(grep -E "^${var}=" .env | cut -d= -f2- || true)"
  if [[ -z "$val" || "$val" == *REPLACE* || "$val" == *change-me* ]]; then
    echo "!! $var is missing or still a placeholder in .env"
    missing=1
  fi
done
[[ $missing -eq 1 ]] && { echo "Fix .env and rerun."; exit 1; }

DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2-)"

echo "==> Pulling / building images"
docker compose -f docker-compose.prod.yml pull || true
docker compose -f docker-compose.prod.yml build

echo "==> Starting stack (postgres, minio, pluto, caddy)"
docker compose -f docker-compose.prod.yml up -d

echo "==> Waiting for API health via Caddy at https://${DOMAIN} …"
./scripts/wait-for-healthy.sh "https://${DOMAIN}" 180

echo "==> Running pending migrations"
docker compose -f docker-compose.prod.yml exec -T pluto node dist/scripts/migrate.js || \
  echo "   (migrations run automatically on boot; skipping manual step)"

cat <<EOF

  Pluto deployed at  https://${DOMAIN}

  Health   https://${DOMAIN}/healthz
  Ready    https://${DOMAIN}/readyz
  Admin    open the dashboard with:
             VITE_PLUTO_URL=https://${DOMAIN}
             VITE_PLUTO_ANON_KEY=\$(grep ^ANON_KEY .env | cut -d= -f2)

  Logs     docker compose -f docker-compose.prod.yml logs -f pluto
  Backup   ./scripts/backup.sh
  Update   git pull && ./scripts/deploy-cloud.sh
EOF
