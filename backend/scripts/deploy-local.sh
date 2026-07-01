#!/usr/bin/env bash
# Boot Pluto for local development.
# Usage:  ./scripts/deploy-local.sh [--fresh]
#
#   --fresh   destroy volumes first (wipes local DB + storage)
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo "==> .env not found, seeding from .env.local.example"
  cp .env.local.example .env
fi

if [[ "${1:-}" == "--fresh" ]]; then
  echo "==> Tearing down volumes"
  docker compose down -v
fi

echo "==> Building images"
docker compose build

echo "==> Starting stack (postgres, minio, mailpit, pluto)"
docker compose up -d

echo "==> Waiting for API to become healthy…"
./scripts/wait-for-healthy.sh "http://localhost:8787" 60

cat <<EOF

  Pluto is up.

  API        http://localhost:8787
  Health     http://localhost:8787/healthz
  Ready      http://localhost:8787/readyz
  MinIO UI   http://localhost:9001   (user: minioadmin)
  Mailpit    http://localhost:8025

  Point your frontend at:
    VITE_PLUTO_URL=http://localhost:8787
    VITE_PLUTO_ANON_KEY=\$(grep ^ANON_KEY .env | cut -d= -f2)

  Tail logs:   docker compose logs -f pluto
  Stop:        docker compose down
EOF
