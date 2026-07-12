#!/usr/bin/env bash
# Print the JWT config the running API container actually expects, and
# (optionally) validate that a token you minted matches. Fails loudly with
# a specific reason when a claim or secret is off.
#
# Usage:
#   pluto-backend/scripts/check-admin-jwt-config.sh                # print expected
#   pluto-backend/scripts/check-admin-jwt-config.sh <token>        # + validate token
#   TOKEN=$(...)  pluto-backend/scripts/check-admin-jwt-config.sh  # via env
#
# Env:
#   COMPOSE_FILE   default: pluto-backend/docker/docker-compose.yml
#   ENV_FILE       default: pluto-backend/.env
#   API_SERVICE    default: api
set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-pluto-backend/docker/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-pluto-backend/.env}"
API_SERVICE="${API_SERVICE:-api}"
TOKEN="${1:-${TOKEN:-}}"

[ -f "$COMPOSE_FILE" ] || { echo "compose file not found: $COMPOSE_FILE" >&2; exit 2; }

echo "── Expected JWT config (from container '$API_SERVICE') ────────────────"
cat <<'EOF'
  Env var name for signing secret : PLUTO_JWT_SECRET   (min 32 chars; must be IDENTICAL in mint + verify)
  Env var name for issuer         : JWT_ISSUER         (default: "pluto")
  Verify enforces                  : iss  = $JWT_ISSUER
                                     alg  = HS256
                                     exp  > now
  Required claim for admin API    : role = "service_role"  (else authorize() returns 401/403)
  Required claim                  : sub  = <uuid>          (used as actor_user_id; non-empty)
  Not enforced by verify          : aud                    (safe to omit; setting it does not fail)
EOF
echo

# Pull the live values from inside the running container.
LIVE=$(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T "$API_SERVICE" \
    node -e '
      const s = process.env.PLUTO_JWT_SECRET || "";
      const iss = process.env.JWT_ISSUER || "pluto";
      const c = require("crypto");
      const fp = s ? c.createHash("sha256").update(s).digest("hex").slice(0,12) : "";
      process.stdout.write(JSON.stringify({ hasSecret: !!s, secretLen: s.length, secretFp: fp, iss }));
    '
) || { echo "✗ could not exec into container '$API_SERVICE' — is it running?" >&2; exit 3; }

HAS_SECRET=$(echo "$LIVE" | sed -n 's/.*"hasSecret":\([a-z]*\).*/\1/p')
SEC_LEN=$(echo   "$LIVE" | sed -n 's/.*"secretLen":\([0-9]*\).*/\1/p')
SEC_FP=$(echo    "$LIVE" | sed -n 's/.*"secretFp":"\([^"]*\)".*/\1/p')
LIVE_ISS=$(echo  "$LIVE" | sed -n 's/.*"iss":"\([^"]*\)".*/\1/p')

echo "── Live values in container ──────────────────────────────────────────"
echo "  PLUTO_JWT_SECRET set : $HAS_SECRET  (length=$SEC_LEN, sha256[0:12]=$SEC_FP)"
echo "  JWT_ISSUER           : $LIVE_ISS"
echo

if [ "$HAS_SECRET" != "true" ] || [ "${SEC_LEN:-0}" -lt 32 ]; then
  echo "✗ PLUTO_JWT_SECRET missing or < 32 chars in the running container." >&2
  echo "  Fix: set PLUTO_JWT_SECRET in $ENV_FILE and 'docker compose up -d $API_SERVICE'." >&2
  exit 4
fi

if [ -z "$TOKEN" ]; then
  echo "ℹ no token supplied — pass one as \$1 or TOKEN=... to validate a minted JWT."
  exit 0
fi

echo "── Validating supplied token ─────────────────────────────────────────"
# Verify token against the container's live secret + expected iss.
RESULT=$(
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T \
    -e CHECK_TOKEN="$TOKEN" "$API_SERVICE" node -e '
      const c = require("crypto");
      const t = process.env.CHECK_TOKEN || "";
      const s = process.env.PLUTO_JWT_SECRET;
      const expectIss = process.env.JWT_ISSUER || "pluto";
      const parts = t.split(".");
      const out = { errors: [], header: null, payload: null, expectIss };
      if (parts.length !== 3) { out.errors.push("not_a_3_part_jwt (got " + parts.length + " parts)"); }
      else {
        const dec = (x) => {
          const pad = "=".repeat((4 - x.length % 4) % 4);
          return JSON.parse(Buffer.from(x.replace(/-/g,"+").replace(/_/g,"/") + pad, "base64").toString("utf8"));
        };
        try { out.header  = dec(parts[0]); } catch (e) { out.errors.push("bad_header_json: " + e.message); }
        try { out.payload = dec(parts[1]); } catch (e) { out.errors.push("bad_payload_json: " + e.message); }
        // signature check
        const expected = c.createHmac("sha256", s).update(parts[0]+"."+parts[1])
          .digest("base64").replace(/=+$/,"").replace(/\+/g,"-").replace(/\//g,"_");
        if (expected !== parts[2]) out.errors.push("signature_mismatch → token was signed with a DIFFERENT PLUTO_JWT_SECRET than the container has");
        // claim checks
        const p = out.payload || {};
        if (out.header && out.header.alg !== "HS256") out.errors.push("header.alg must be HS256, got " + out.header.alg);
        if (!p.iss)  out.errors.push("payload.iss missing");
        else if (p.iss !== expectIss) out.errors.push('payload.iss = "' + p.iss + '" but container expects "' + expectIss + '"');
        if (!p.sub)  out.errors.push("payload.sub missing (used as actor_user_id)");
        if (!p.role) out.errors.push('payload.role missing — admin routes require "service_role"');
        else if (p.role !== "service_role") out.errors.push('payload.role = "' + p.role + '" — admin routes require "service_role"');
        if (!p.exp)  out.errors.push("payload.exp missing");
        else if (p.exp <= Math.floor(Date.now()/1000)) out.errors.push("payload.exp is in the past (token expired)");
      }
      process.stdout.write(JSON.stringify(out));
    '
)

# Pretty-print
echo "$RESULT" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o=JSON.parse(s);
    if (o.header)  console.log("  header :", JSON.stringify(o.header));
    if (o.payload) console.log("  payload:", JSON.stringify(o.payload));
    console.log("  expect iss:", o.expectIss);
    if (o.errors.length===0) { console.log("\n✓ token matches container config"); process.exit(0); }
    console.error("\n✗ token does NOT match container config:");
    for (const e of o.errors) console.error("  - " + e);
    process.exit(1);
  });
'
