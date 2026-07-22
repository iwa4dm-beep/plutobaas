#!/usr/bin/env bash
# verify-pluto-cutover.sh
# ---------------------------------------------------------------
# Verify that the deployed frontend at <domain> is talking to Pluto
# (api.timescard.cloud), not Supabase.
#
# Usage:
#   bash verify-pluto-cutover.sh app.timescard.cloud
# ---------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-app.timescard.cloud}"
BASE="https://$DOMAIN"
PLUTO_API="${PLUTO_API_BASE:-https://api.timescard.cloud}"

red()   { printf "\033[1;31m✗ %s\033[0m\n" "$*"; }
green() { printf "\033[1;32m✔ %s\033[0m\n" "$*"; }
warn()  { printf "\033[1;33m! %s\033[0m\n" "$*"; }
info()  { printf "\033[1;36m→ %s\033[0m\n" "$*"; }

FAIL=0

info "Fetching $BASE …"
HTML=$(curl -sSL --max-time 10 "$BASE/" || true)
if [[ -z "$HTML" ]]; then red "Site unreachable"; exit 1; fi

# Extract asset URLs from index.html
mapfile -t ASSETS < <(echo "$HTML" | grep -oE '/assets/[a-zA-Z0-9._/-]+\.js' | sort -u | head -20)
if [[ ${#ASSETS[@]} -eq 0 ]]; then
  warn "No /assets/*.js found in index — non-Vite build or unusual layout."
fi

TMP=$(mktemp -d); trap "rm -rf $TMP" EXIT
printf '%s' "$HTML" > "$TMP/index.html"
for a in "${ASSETS[@]}"; do
  curl -sSL --max-time 10 "$BASE$a" >> "$TMP/all.js" 2>/dev/null || true
done
curl -sSL --max-time 5 "$BASE/env.js" -o "$TMP/env.js" 2>/dev/null || true
curl -sSL --max-time 5 "$BASE/sw.js" -o "$TMP/sw.js" 2>/dev/null || true
cat "$TMP/index.html" "$TMP/all.js" "$TMP/env.js" "$TMP/sw.js" > "$TMP/all.txt" 2>/dev/null || true
BYTES=$(wc -c < "$TMP/all.js" 2>/dev/null || echo 0)
info "Concatenated JS: $BYTES bytes"

# ---- Check 1: Pluto URL present ----
if grep -qE 'api\.timescard\.cloud' "$TMP/all.txt" 2>/dev/null; then
  green "Pluto API URL (api.timescard.cloud) found in deployed HTML/JS/env"
else
  red "Pluto API URL NOT found in deployed HTML/JS/env"
  FAIL=1
fi

# ---- Check 2: Pluto publishable/anon key present ----
if grep -qE 'pk(_anon)?_[a-zA-Z0-9]+' "$TMP/all.txt" 2>/dev/null; then
  green "Pluto anon key (pk_…) found in deployed HTML/JS/env"
else
  red "Pluto anon key NOT found in deployed HTML/JS/env"
  FAIL=1
fi

if grep -q 'pk_anon_REPLACE_ME' "$TMP/all.txt" 2>/dev/null; then
  red "Placeholder pk_anon_REPLACE_ME is still deployed"
  FAIL=1
fi

# ---- Check 3: Supabase leftovers ----
LEFT=$(grep -oE 'https://[a-z0-9-]+\.supabase\.(co|in)' "$TMP/all.txt" 2>/dev/null | sort -u || true)
if [[ -n "$LEFT" ]]; then
  red "Supabase URLs still present in deployed HTML/JS/env/sw:"
  echo "$LEFT" | sed 's/^/     /'
  echo
  grep -RIn 'supabase\.(co\|in)' "$TMP" 2>/dev/null | sed 's/^/     source: /' | head -20 || true
  FAIL=1
else
  green "No supabase.co URLs left in deployed HTML/JS/env/sw"
fi

# ---- Check 4: Pluto backend reachable ----
info "Probing $PLUTO_API/health …"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$PLUTO_API/health" || echo 000)
if [[ "$CODE" =~ ^2 ]]; then
  green "Pluto backend healthy ($PLUTO_API/health → $CODE)"
else
  warn "Pluto /health returned $CODE (may still be OK if health path differs)"
fi

# ---- Check 5: Pluto auth endpoint responsive ----
info "Probing $PLUTO_API/auth/v1/settings …"
CODE=$(curl -s -o "$TMP/settings.json" -w '%{http_code}' --max-time 5 "$PLUTO_API/auth/v1/settings" || echo 000)
if [[ "$CODE" =~ ^[23] ]]; then
  green "Pluto auth endpoint responsive (HTTP $CODE)"
else
  warn "Pluto auth endpoint returned $CODE — verify SUPABASE_URL/anon-key equivalent on VPS"
fi

echo
if [[ $FAIL -eq 0 ]]; then
  green "==== CUTOVER VERIFIED — frontend is on Pluto ✅ ===="
  exit 0
else
  red "==== CUTOVER INCOMPLETE — see failures above ❌ ===="
  echo
  echo "Common fixes:"
  echo "  • Rebuild after editing .env (VITE_PLUTO_URL, VITE_PLUTO_ANON_KEY)"
  echo "  • Re-run migrate-frontend-to-pluto.sh; it now also cleans index.html preconnects"
  echo "  • Confirm source is clean: grep -R --exclude='*.bak-supabase' --exclude-dir=node_modules --exclude-dir=dist 'supabase.co' src index.html public"
  echo "  • Re-deploy the freshly built dist/ (or use deploy-local-zip-to-primary.sh to bypass sandbox-secret issues)"
  exit 1
fi
