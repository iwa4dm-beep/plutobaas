#!/usr/bin/env bash
# One-click VPS deploy for Pluto backend.
# Runs each phase, logs every step to /var/log/pluto-deploy-<ts>.log,
# prints a compact status line per step, and stops at the first failure.
#
# Usage (as root on a fresh Ubuntu 22.04/24.04 VPS):
#   DOMAIN=api.example.com  ACME_EMAIL=admin@example.com \
#     bash deploy/one-click-vps.sh
#
# Optional env:
#   SKIP_TLS=1     — skip certbot (useful for staging / IP-only)
#   NO_UFW=1       — skip firewall configuration
set -euo pipefail

: "${DOMAIN:?DOMAIN=api.example.com লাগবে}"
: "${ACME_EMAIL:=admin@${DOMAIN#*.}}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="/var/log/pluto-deploy-${TS}.log"
mkdir -p /var/log
touch "$LOG"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

C_GRN='\033[1;32m'; C_RED='\033[1;31m'; C_YLW='\033[1;33m'; C_DIM='\033[2m'; C_RST='\033[0m'

step() {
  local title="$1"; shift
  local start=$(date +%s)
  printf "\n${C_YLW}▶ %s${C_RST}\n" "$title" | tee -a "$LOG"
  printf "${C_DIM}  log: %s${C_RST}\n" "$LOG"
  if "$@" >>"$LOG" 2>&1; then
    printf "${C_GRN}  ✔ done (%ss)${C_RST}\n" "$(( $(date +%s) - start ))"
  else
    local rc=$?
    printf "${C_RED}  ✘ FAILED (exit %d) — see %s${C_RST}\n" "$rc" "$LOG"
    tail -n 40 "$LOG" | sed 's/^/    | /'
    exit $rc
  fi
}

banner() { printf "\n${C_GRN}══ %s ══${C_RST}\n" "$1" | tee -a "$LOG"; }

banner "Pluto one-click VPS deploy — ${DOMAIN}"
echo "log file: $LOG"

# 1. OS packages
step "APT update + install base packages (docker, nginx, certbot, ufw, jq)" bash -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y ca-certificates curl gnupg jq ufw nginx
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sh
  fi
  if ! command -v certbot >/dev/null; then
    apt-get install -y certbot python3-certbot-nginx
  fi
'

# 2. Firewall
if [ "${NO_UFW:-0}" != "1" ]; then
  step "Configure UFW (allow 22/80/443, deny rest)" bash -c '
    ufw --force reset
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp
    ufw allow 80/tcp
    ufw allow 443/tcp
    ufw --force enable
    ufw status verbose
  '
fi

# 3. .env
step "Ensure .env exists (copy from .env.example if missing)" bash -c "
  if [ ! -f .env ]; then
    cp .env.example .env
    echo '⚠ new .env from template — rotate secrets before going public!'
  fi
"

# 4. Preflight
step "Preflight: docker + env sanity check" bash -c '
  docker --version
  docker compose version
  bash deploy/check-env.sh || true
'

# 5. Build & start stack
step "docker compose build" docker compose --env-file .env -f docker/docker-compose.yml build
step "docker compose up -d (postgres, redis, minio, api)" \
  docker compose --env-file .env -f docker/docker-compose.yml up -d

# 6. Wait for API health
step "Wait for API health at http://127.0.0.1:3000/v1/health" bash -c '
  for i in $(seq 1 60); do
    if curl -fsS http://127.0.0.1:3000/v1/health >/dev/null 2>&1; then
      echo "API healthy after ${i}s"; exit 0
    fi
    sleep 2
  done
  echo "API never became healthy"; docker compose -f docker/docker-compose.yml logs --tail=100 api
  exit 1
'

# 7. Migrations
step "Run migrations (one-shot migrator)" bash -c '
  docker compose --env-file .env -f docker/docker-compose.yml \
    -f docker/docker-compose.migrator.yml run --rm migrator || \
  docker compose --env-file .env -f docker/docker-compose.yml exec -T api \
    node /app/packages/api/dist/scripts/migrate.js || true
'

# 8. Nginx site
step "Install nginx site for ${DOMAIN}" bash deploy/install-nginx-site.sh "${DOMAIN}"

# 9. TLS via Let's Encrypt
if [ "${SKIP_TLS:-0}" != "1" ]; then
  step "Obtain Let's Encrypt cert for ${DOMAIN}" bash -c "
    certbot --nginx -d '${DOMAIN}' --agree-tos -m '${ACME_EMAIL}' -n --redirect
    systemctl reload nginx
  "
fi

# 10. systemd auto-start
step "Install + enable systemd units (backend + migrator timer)" \
  bash deploy/install-systemd.sh

# 11. Final smoke
step "Smoke: GET https://${DOMAIN}/v1/health" bash -c "
  set +e
  code=\$(curl -sk -o /tmp/health.json -w '%{http_code}' https://${DOMAIN}/v1/health)
  echo \"HTTP \$code\"; cat /tmp/health.json; echo
  [ \"\$code\" = \"200\" ]
"

banner "✅ Deploy complete — https://${DOMAIN}"
cat <<EOF
Next steps:
  • journalctl -u pluto-backend  -f     # live API logs
  • journalctl -u pluto-migrator -f     # migration runs
  • docker compose -f docker/docker-compose.yml ps
  • Full deploy log: $LOG
EOF
