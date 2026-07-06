#!/usr/bin/env bash
# Compose env preflight — explicitly loads .env (repo root) and fails fast
# if any required variable is missing or still set to a CHANGE_ME placeholder.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "✘ .env not found at $ENV_FILE"
  echo "   cp $ROOT/.env.example $ENV_FILE   # then edit values"
  exit 1
fi

# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
echo "▶ loaded $ENV_FILE"

REQUIRED=(
  DATABASE_URL
  POSTGRES_PASSWORD
  PLUTO_JWT_SECRET
  JWT_ISSUER
  S3_ACCESS_KEY
  S3_SECRET_KEY
  S3_BUCKET
  REDIS_URL
  PUBLIC_API_URL
)

missing=0
placeholder=0
for k in "${REQUIRED[@]}"; do
  v="${!k:-}"
  if [ -z "$v" ]; then
    echo "  ✘ $k is unset"
    missing=1
  elif [[ "$v" == *CHANGE_ME* ]]; then
    echo "  ✘ $k still contains CHANGE_ME placeholder"
    placeholder=1
  else
    echo "  ✔ $k set (${#v} chars)"
  fi
done

if [ "$missing$placeholder" != "00" ]; then
  echo "✖ .env is incomplete — fix the entries above before running compose"
  exit 1
fi

# Sanity: POSTGRES_PASSWORD must appear inside DATABASE_URL when the URL
# points at the compose postgres service, otherwise the API container will
# fail to authenticate.
if [[ "$DATABASE_URL" == *"@postgres:"* ]] && [[ "$DATABASE_URL" != *"$POSTGRES_PASSWORD"* ]]; then
  echo "✘ DATABASE_URL points at compose 'postgres' host but does not embed POSTGRES_PASSWORD"
  exit 1
fi

echo "✔ .env passes required-var check"
