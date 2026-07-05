#!/usr/bin/env bash
# Rotate the sensitive default secrets in .env in place.
# Creates a timestamped backup, generates fresh values with openssl,
# and updates: PLUTO_JWT_SECRET, POSTGRES_PASSWORD, S3_ACCESS_KEY,
# S3_SECRET_KEY, ANON_KEY, SERVICE_ROLE_KEY.
#
# IMPORTANT: after running, you must also
#   1) reset the postgres password inside the DB (see printed hint)
#   2) restart the stack: docker compose ... up -d
#   3) re-issue any client SDK / tokens that hardcoded ANON_KEY
set -euo pipefail

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "❌ $ENV_FILE not found"; exit 1; }

BACKUP="$ENV_FILE.bak.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$ENV_FILE" "$BACKUP"
echo "▶ backup: $BACKUP"

# Capture the old postgres password before we overwrite it
OLD_PG_PW=$(grep -E '^POSTGRES_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)

set_kv() {
  local key="$1" val="$2"
  # Escape & and / for sed replacement
  local esc; esc=$(printf '%s' "$val" | sed -e 's/[\/&]/\\&/g')
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s/^${key}=.*/${key}=${esc}/" "$ENV_FILE"
  else
    printf '\n%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
  echo "  ✔ $key rotated"
}

JWT=$(openssl rand -hex 48)
PG_PW=$(openssl rand -hex 24)
S3_AK=$(openssl rand -hex 12 | tr 'a-z' 'A-Z')
S3_SK=$(openssl rand -hex 32)
ANON=pk_anon_$(openssl rand -hex 24)
SR=sk_service_$(openssl rand -hex 24)

set_kv PLUTO_JWT_SECRET   "$JWT"
set_kv POSTGRES_PASSWORD  "$PG_PW"
set_kv S3_ACCESS_KEY      "$S3_AK"
set_kv S3_SECRET_KEY      "$S3_SK"
set_kv ANON_KEY           "$ANON"
set_kv SERVICE_ROLE_KEY   "$SR"

# Update DATABASE_URL to embed the new password (host/db kept as-is)
if grep -qE '^DATABASE_URL=' "$ENV_FILE"; then
  # Extract host:port/db from current URL
  CUR=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
  TAIL=$(echo "$CUR" | sed -E 's#^postgres://[^@]+@##')
  set_kv DATABASE_URL "postgres://pluto:${PG_PW}@${TAIL}"
fi

cat <<EOF

✅ Rotated. Next steps (run in order):

  # 1) Update Postgres user password to match new POSTGRES_PASSWORD
  docker compose --env-file .env -f docker/docker-compose.yml exec postgres \\
    psql -U pluto -d pluto -c "ALTER USER pluto WITH PASSWORD '$PG_PW';"

  # 2) Update MinIO keys to match new S3_ACCESS_KEY / S3_SECRET_KEY
  #    (easiest = wipe the minio volume; only safe if you have no unbacked-up objects)
  #    Otherwise use mc: mc admin user svcacct add ...

  # 3) Restart stack with the new env
  docker compose --env-file .env -f docker/docker-compose.yml up -d --build

  # 4) Re-issue any client SDK config that hardcoded ANON_KEY.

Old postgres password (kept in $BACKUP): $OLD_PG_PW
EOF
