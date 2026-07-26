#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Pluto BaaS starter — one-shot setup for local / docker / cloud.
# Usage:  bash scripts/setup-starter.sh {local|docker|cloud}
# Copies the right env template into examples/nextjs-starter/.env.local,
# prints next steps, and (best-effort) applies setup.sql via psql when
# DATABASE_URL is exported.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

MODE="${1:-local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STARTER="$ROOT/examples/nextjs-starter"
ENV_OUT="$STARTER/.env.local"
SQL="$ROOT/examples/lovable-frontend/setup.sql"

if [[ ! -d "$STARTER" ]]; then
  echo "✗ Starter not found at $STARTER" >&2
  exit 1
fi

cp -n "$STARTER/.env.example" "$ENV_OUT" 2>/dev/null || true

case "$MODE" in
  local)
    URL="http://localhost:3000"
    PLUTO="http://localhost:8000"
    ;;
  docker)
    URL="http://localhost:3000"
    PLUTO="http://pluto-api:8000"
    ;;
  cloud)
    URL="${STARTER_URL:-https://your-app.example.com}"
    PLUTO="${PLUTO_URL:-https://api.your-domain.com}"
    ;;
  *)
    echo "Unknown mode: $MODE (use local|docker|cloud)" >&2
    exit 2
    ;;
esac

# Rewrite NEXT_PUBLIC_PLUTO_URL in place (portable sed)
tmp="$(mktemp)"
awk -v pluto="$PLUTO" '
  /^NEXT_PUBLIC_PLUTO_URL=/ { print "NEXT_PUBLIC_PLUTO_URL=" pluto; next }
  { print }
' "$ENV_OUT" > "$tmp" && mv "$tmp" "$ENV_OUT"

echo "✓ Mode: $MODE"
echo "✓ Wrote $ENV_OUT (NEXT_PUBLIC_PLUTO_URL=$PLUTO)"
echo "  Starter URL: $URL"

if [[ -n "${DATABASE_URL:-}" && -f "$SQL" ]] && command -v psql >/dev/null 2>&1; then
  echo "→ Applying $SQL via psql…"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SQL" && echo "✓ schema applied"
else
  echo "ℹ Skipped SQL apply (export DATABASE_URL and install psql to auto-run $SQL)"
fi

cat <<EOF

Next steps:
  1. Fill secrets in $ENV_OUT (ANON key, SERVICE_ROLE key, WEBHOOK secret).
  2. cd examples/nextjs-starter && npm install
  3. npm run dev
  4. Open $URL, sign up, add a note.
  5. Point a Pluto webhook at ${URL}/api/webhooks/pluto with the same WEBHOOK secret.
EOF
