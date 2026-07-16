#!/usr/bin/env bash
# Pluto sandbox — one-shot nginx installer for the sandbox-worker.
#
# What it does:
#   1. Idempotently injects /sites/ + /preview/ proxy blocks into the existing
#      api.timescard.cloud HTTPS server block (delimited by AUTO markers).
#   2. Optionally installs the wildcard *.app.<APEX> vhost that routes
#      <slug>.app.<APEX>       → worker /sites/<slug>/
#      <slug>-dev.app.<APEX>   → worker /preview/<slug>/
#   3. Issues a Let's Encrypt cert for the wildcard (via
#      deploy/install-wildcard-tls.sh) if --wildcard is used and no cert exists.
#   4. `nginx -t` + `systemctl reload nginx`.
#
# Usage:
#   sudo bash pluto-backend/deploy/install-sites-proxy.sh
#   sudo bash pluto-backend/deploy/install-sites-proxy.sh --wildcard app.timescard.cloud
#   sudo bash pluto-backend/deploy/install-sites-proxy.sh --api-conf /etc/nginx/sites-enabled/api.timescard.cloud.conf
#
# Env:
#   ACME_EMAIL   — contact email for Let's Encrypt (defaults to admin@<zone>)
#   CF_INI       — path to Cloudflare API creds for DNS-01 (default /etc/letsencrypt/cloudflare.ini)
#
# Safe to re-run — it detects existing markers and replaces in place.

set -euo pipefail

SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"
here="$(cd "$(dirname "$0")" && pwd)"

API_CONF=""
WILDCARD_APEX=""
while [ $# -gt 0 ]; do
  case "$1" in
    --api-conf)  API_CONF="$2"; shift 2 ;;
    --wildcard)  WILDCARD_APEX="${2:-app.timescard.cloud}"; shift 2 ;;
    --help|-h)   sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

# --- Auto-detect the api.timescard.cloud vhost file if not given ---------
if [ -z "$API_CONF" ]; then
  for c in \
    /etc/nginx/sites-enabled/api.timescard.cloud.conf \
    /etc/nginx/sites-available/api.timescard.cloud.conf \
    /etc/nginx/conf.d/api.timescard.cloud.conf; do
    [ -f "$c" ] && API_CONF="$c" && break
  done
fi

if [ -z "$API_CONF" ] || [ ! -f "$API_CONF" ]; then
  echo "✗ Could not find api.timescard.cloud nginx vhost file."
  echo "  Pass explicitly: --api-conf /path/to/api.timescard.cloud.conf"
  exit 1
fi
echo "▶ Using api vhost: $API_CONF"

SNIPPET="$here/nginx/sites-proxy.snippet.conf"
[ -f "$SNIPPET" ] || { echo "✗ missing snippet: $SNIPPET"; exit 1; }

# --- Inject snippet into the HTTPS server{} block --------------------------
$SUDO cp -a "$API_CONF" "${API_CONF}.bak.$(date +%s)"

python3 - "$API_CONF" "$SNIPPET" <<'PY'
import re, sys, io, os, tempfile
conf_path, snippet_path = sys.argv[1], sys.argv[2]
with open(conf_path, "r", encoding="utf-8") as f: conf = f.read()
with open(snippet_path, "r", encoding="utf-8") as f: snippet = f.read().strip()

# Strip any previously injected block (AUTO markers)
conf = re.sub(
    r"\n?\s*# --- BEGIN pluto-sites-proxy \(AUTO\) ---.*?# --- END pluto-sites-proxy \(AUTO\) ---\s*",
    "\n", conf, flags=re.S)

# Find the HTTPS server{} block — the one that listens on 443 and mentions ssl_certificate.
# Insert the snippet just before its closing brace.
matches = list(re.finditer(r"server\s*\{", conf))
if not matches:
    print("✗ no server{} block found in", conf_path, file=sys.stderr); sys.exit(1)

def find_block_end(text, open_idx):
    depth = 0
    i = open_idx
    while i < len(text):
        if text[i] == "{": depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0: return i
        i += 1
    return -1

target_end = -1; target_start = -1
for m in matches:
    open_brace = m.end() - 1
    end = find_block_end(conf, open_brace)
    if end < 0: continue
    body = conf[open_brace:end]
    if re.search(r"listen\s+443", body) and "ssl_certificate" in body:
        target_start, target_end = open_brace, end
        break

if target_end < 0:
    print("✗ no HTTPS (443 ssl) server{} block found", file=sys.stderr); sys.exit(1)

indent = "    "
inserted = "\n" + "\n".join(indent + line if line.strip() else line for line in snippet.splitlines()) + "\n"
new = conf[:target_end] + inserted + conf[target_end:]

fd, tmp = tempfile.mkstemp(dir=os.path.dirname(conf_path))
with os.fdopen(fd, "w", encoding="utf-8") as f: f.write(new)
os.replace(tmp, conf_path)
print("✓ injected /sites/ + /preview/ blocks into HTTPS server{}")
PY

# --- Optional: wildcard vhost + TLS --------------------------------------
if [ -n "$WILDCARD_APEX" ]; then
  echo "▶ Installing wildcard vhost for *.${WILDCARD_APEX}"
  TPL="$here/nginx/wildcard-app.conf.template"
  DST="/etc/nginx/sites-available/pluto-wildcard-${WILDCARD_APEX}.conf"
  LINK="/etc/nginx/sites-enabled/pluto-wildcard-${WILDCARD_APEX}.conf"
  $SUDO mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  $SUDO sed "s/__APEX__/${WILDCARD_APEX//./\\.}/g" "$TPL" | $SUDO tee "$DST" >/dev/null
  # sed replacement above accidentally escapes dots too much — redo simply:
  $SUDO sed -i "s/__APEX__/${WILDCARD_APEX}/g" "$DST"
  $SUDO ln -sfn "$DST" "$LINK"

  CERT_LIVE="/etc/letsencrypt/live/${WILDCARD_APEX}"
  if [ ! -s "${CERT_LIVE}/fullchain.pem" ]; then
    echo "▶ No cert found at ${CERT_LIVE} — issuing wildcard via install-wildcard-tls.sh"
    ACME_EMAIL="${ACME_EMAIL:-}" CF_INI="${CF_INI:-/etc/letsencrypt/cloudflare.ini}" \
      $SUDO bash "$here/install-wildcard-tls.sh" "$WILDCARD_APEX"
  else
    echo "✓ existing cert reused at ${CERT_LIVE}"
  fi
fi

# --- Test + reload -------------------------------------------------------
echo "▶ nginx -t"
$SUDO nginx -t
echo "▶ systemctl reload nginx"
$SUDO systemctl reload nginx
echo "✓ Done."
echo
echo "Next: run the verifier —"
echo "  bash $here/verify-served-site.sh <slug>"
