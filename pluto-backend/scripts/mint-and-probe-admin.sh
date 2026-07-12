#!/usr/bin/env bash
# One-command: mint an HS256 admin JWT inside the running `api` container
# (so it uses the container's own PLUTO_JWT_SECRET / JWT_ISSUER) and probe
# GET /admin/v1/workspaces?limit=1 through the public URL.
#
# Usage (from the repo root on the VPS):
#   PLUTO_URL=https://api.timescard.cloud ./pluto-backend/scripts/mint-and-probe-admin.sh
#
# Optional env:
#   PLUTO_URL       default: http://localhost:8080
#   COMPOSE_FILE    default: pluto-backend/docker/docker-compose.yml
#   ENV_FILE        default: pluto-backend/.env
#   API_SERVICE     default: api
#   TTL_SECONDS     default: 3600
#   ROLE            default: service_role
set -euo pipefail

PLUTO_URL="${PLUTO_URL:-http://localhost:8080}"
COMPOSE_FILE="${COMPOSE_FILE:-pluto-backend/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-pluto-backend/.env}"
API_SERVICE="${API_SERVICE:-api}"
TTL_SECONDS="${TTL_SECONDS:-3600}"
ROLE="${ROLE:-service_role}"

if [ ! -f "$COMPOSE_FILE" ]; then
  echo "compose file not found: $COMPOSE_FILE" >&2; exit 2
fi

echo "→ minting $ROLE JWT inside container '$API_SERVICE' (ttl=${TTL_SECONDS}s)"
TOKEN=$(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
    -e MINT_ROLE="$ROLE" -e MINT_TTL="$TTL_SECONDS" \
    "$API_SERVICE" node -e '
      const c = require("crypto");
      const s = process.env.PLUTO_JWT_SECRET;
      if (!s) { console.error("PLUTO_JWT_SECRET missing in container env"); process.exit(3); }
      const iss = process.env.JWT_ISSUER || "pluto";
      const b = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o))
        .toString("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
      const now = Math.floor(Date.now()/1000);
      const ttl = parseInt(process.env.MINT_TTL || "3600", 10);
      const h = b({ alg:"HS256", typ:"JWT" });
      const p = b({
        sub: "00000000-0000-0000-0000-000000000000",
        role: process.env.MINT_ROLE || "service_role",
        iss, aud: "authenticated",
        iat: now, exp: now + ttl,
      });
      const sig = c.createHmac("sha256", s).update(h + "." + p)
        .digest("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
      process.stdout.write(h + "." + p + "." + sig);
    '
)

if [ -z "$TOKEN" ] || [ "$(echo -n "$TOKEN" | tr -cd '.' | wc -c)" != "2" ]; then
  echo "✗ mint failed — token is empty or not a 3-part JWT" >&2
  exit 4
fi
echo "  token: ${TOKEN:0:24}…${TOKEN: -12}  (len=${#TOKEN})"

URL="$PLUTO_URL/admin/v1/workspaces?limit=1"
echo "→ probing $URL"
TMP=$(mktemp)
CODE=$(curl -sS -o "$TMP" -w "%{http_code}" \
  -H "apikey: $TOKEN" -H "authorization: Bearer $TOKEN" \
  -H "accept: application/json" "$URL" || echo "000")

echo "  HTTP $CODE"
echo "  body: $(head -c 400 "$TMP")"
rm -f "$TMP"

if [ "$CODE" = "200" ]; then
  echo "✓ admin API reachable with container-minted JWT"
  exit 0
fi
echo "✗ expected 200, got $CODE" >&2
exit 1
