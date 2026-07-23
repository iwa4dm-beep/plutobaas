#!/usr/bin/env bash
# fix-primary-env.sh
# ------------------------------------------------------------------
# Re-injects /env.js at the LIVE primary webroot so the running SPA
# gets a real Pluto anonKey/URL — without a full rebuild+cutover.
#
# Symptom this fixes:
#   window.__PLUTO_ENV__.anonKey === "pk_..."   (placeholder literal)
#   → SDK cannot authenticate, realtime/rest calls fail, frontend
#     appears "broken" even though HTML/CSS/JS load fine.
#
# Usage on VPS:
#   sudo VITE_PLUTO_URL=https://api.timescard.cloud \
#        VITE_PLUTO_ANON_KEY=pk_anon_REAL_KEY_HERE \
#        bash pluto-backend/deploy/fix-primary-env.sh
#
# Optional:
#   PRIMARY_ROOT=/var/lib/pluto/sites/_primary/current  (auto-detected)
set -euo pipefail

die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
info() { printf '\033[1;34m▶ %s\033[0m\n' "$*"; }

URL="${VITE_PLUTO_URL:-${PLUTO_URL:-https://api.timescard.cloud}}"
KEY="${VITE_PLUTO_ANON_KEY:-${PLUTO_ANON_KEY:-}}"

[[ -n "$KEY" ]] || die "VITE_PLUTO_ANON_KEY (or PLUTO_ANON_KEY) is required — pass the REAL publishable/anon key, not pk_..."
case "$KEY" in
  pk_anon_REPLACE_ME|REPLACE_ME|CHANGE_ME|YOUR_KEY|*...*|*…*)
    die "Refusing to write placeholder key: '$KEY'"
    ;;
esac

PRIMARY_LINK="/var/lib/pluto/sites/_primary/current"
PRIMARY_ROOT="${PRIMARY_ROOT:-$PRIMARY_LINK}"

resolve_primary_root() {
  local root="$1"
  local found=""

  if [[ -e "$root" || -L "$root" ]]; then
    local resolved=""
    resolved="$(readlink -f "$root" 2>/dev/null || true)"
    if [[ -n "$resolved" && -d "$resolved" ]]; then
      root="$resolved"
    fi
  fi

  if [[ -d "$root" && -f "$root/index.html" ]]; then
    printf '%s\n' "$root"
    return 0
  fi

  if [[ -d "$root" ]]; then
    found="$(find -L "$root" -maxdepth 8 -type f -name index.html 2>/dev/null | head -1 || true)"
    if [[ -n "$found" ]]; then
      dirname "$found"
      return 0
    fi
  fi

  # Last resort: primary symlink is stale/broken, so search deployed releases.
  found="$({
    find -L /var/lib/pluto/sites/_primary /var/lib/pluto/sites -maxdepth 8 -type f -name index.html 2>/dev/null || true
  } | grep -v '/node_modules/' | sort | tail -1)"
  if [[ -n "$found" ]]; then
    dirname "$found"
    return 0
  fi

  return 1
}

PRIMARY_ROOT="$(resolve_primary_root "$PRIMARY_ROOT" || true)"
[[ -n "$PRIMARY_ROOT" && -f "$PRIMARY_ROOT/index.html" ]] || die "index.html not found. No built frontend release exists under /var/lib/pluto/sites. Deploy/cutover a dist zip first, then rerun this script."

# Repair stale _primary/current symlink so nginx serves the located release.
mkdir -p /var/lib/pluto/sites/_primary
if [[ "$(readlink -f "$PRIMARY_LINK" 2>/dev/null || true)" != "$PRIMARY_ROOT" ]]; then
  rm -f "$PRIMARY_LINK"
  ln -s "$PRIMARY_ROOT" "$PRIMARY_LINK"
  pass "repaired primary symlink: $PRIMARY_LINK -> $PRIMARY_ROOT"
fi

info "Primary webroot: $PRIMARY_ROOT"

TS="$(date -u +%FT%TZ)"
if [[ -f "$PRIMARY_ROOT/env.js" ]]; then
  cp -a "$PRIMARY_ROOT/env.js" "$PRIMARY_ROOT/env.js.bak.$(date +%s)" || true
fi

cat > "$PRIMARY_ROOT/env.js" <<EOF
// re-injected by fix-primary-env.sh at $TS
window.__PLUTO_ENV__ = {
  url: "$URL",
  anonKey: "$KEY",
  VITE_PLUTO_URL: "$URL",
  VITE_PLUTO_ANON_KEY: "$KEY"
};
EOF
chown --reference="$PRIMARY_ROOT/index.html" "$PRIMARY_ROOT/env.js" 2>/dev/null || true
chmod 0644 "$PRIMARY_ROOT/env.js"
pass "wrote $PRIMARY_ROOT/env.js (url=$URL, key=${KEY:0:12}…)"

# make sure index.html references /env.js
if ! grep -q '/env.js' "$PRIMARY_ROOT/index.html"; then
  python3 - "$PRIMARY_ROOT/index.html" <<'PY'
import sys, re
p = sys.argv[1]
html = open(p, encoding='utf-8', errors='ignore').read()
tag = '<script src="/env.js"></script>'
if '/env.js' not in html:
    html = re.sub(r'(<head[^>]*>)', r'\1\n    ' + tag, html, count=1, flags=re.I)
    open(p, 'w', encoding='utf-8').write(html)
    print("injected /env.js script tag")
PY
fi

# verify via nginx (bust cache)
info "Verifying live env.js"
SERVED="$(curl -fsS -H 'Cache-Control: no-cache' "https://app.timescard.cloud/env.js?ts=$(date +%s)" || true)"
echo "$SERVED" | head -8
if echo "$SERVED" | grep -qE 'anonKey:\s*"pk_\.\.\.'; then
  die "Live env.js STILL shows placeholder — check nginx cache / webroot path"
fi
if echo "$SERVED" | grep -qF "$KEY"; then
  pass "Live env.js now serves real anon key"
else
  printf '\033[1;33m! Served env.js does not contain the injected key yet (CDN/nginx cache?). Try: sudo nginx -s reload\033[0m\n'
fi
