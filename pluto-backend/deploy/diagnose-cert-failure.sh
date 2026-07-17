#!/usr/bin/env bash
# diagnose-cert-failure.sh — read certbot + nginx logs and print
# ROOT CAUSE + the exact next command for the most common failure modes:
#
#   • "Specified mismatched certificate name and domains" (interactive cancel)
#   • "unrecognized arguments: --dns-cloudflare-credentials"
#   • "urn:ietf:params:acme:error:unauthorized" (HTTP-01 challenge failed)
#   • "urn:ietf:params:acme:error:rateLimited"
#   • "urn:ietf:params:acme:error:dns"       (DNS-01 propagation)
#   • "ssl_certificate ... cannot load"       (nginx pointing at missing file)
#   • "unknown log format \"pluto_slug_json\"" (stale per-slug nginx template)
#
# Usage:
#   sudo bash pluto-backend/deploy/diagnose-cert-failure.sh [slug] [base]

set -uo pipefail
SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"
LOG="/var/log/letsencrypt/letsencrypt.log"

red()   { printf "\033[31m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yell()  { printf "\033[33m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

bold "▸ certbot log: $LOG"
if [[ ! -r "$LOG" ]]; then
  red "  Cannot read $LOG. Run this script with sudo."
  exit 2
fi

TAIL="$(tail -n 400 "$LOG" 2>/dev/null || true)"
NGINX_TAIL="$(tail -n 200 /var/log/nginx/error.log 2>/dev/null || true)"

hit() { grep -qi -- "$1" <<<"$TAIL"; }
nghit() { grep -qi -- "$1" <<<"$NGINX_TAIL"; }

FOUND=0

# ── 1. Interactive "mismatched certificate name" cancel ──────────────────────
if hit "Specified mismatched certificate name" || hit "did you intend to make this change"; then
  FOUND=1
  red "✗ ROOT CAUSE: You cancelled certbot's interactive 'expand cert' prompt (pressed C)."
  cat <<MSG

  certbot found an existing cert named 'app.timescard.cloud' and asked whether
  to expand it to include '*.app.timescard.cloud'. You answered C (Cancel), so
  the cert was not updated and nginx has no wildcard cert to load.

  Fix — rerun WITHOUT the interactive prompt:

    sudo certbot certonly --expand --non-interactive --agree-tos \\
      -m admin@${BASE#*.} \\
      --cert-name app.${BASE#*.} \\
      -d app.${BASE#*.} -d '*.app.${BASE#*.}' \\
      <ACME-METHOD-FLAGS>

  If the zone is NOT on Cloudflare, use per-slug HTTP-01 instead:
    sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
MSG
fi

# ── 2. Cloudflare plugin missing ─────────────────────────────────────────────
if hit "unrecognized arguments: --dns-cloudflare"; then
  FOUND=1
  red "✗ ROOT CAUSE: certbot's dns-cloudflare plugin is not installed."
  cat <<MSG

  Fix:
    sudo apt-get update && sudo apt-get install -y python3-certbot-dns-cloudflare
    # or:  sudo snap install certbot-dns-cloudflare
    # or:  sudo pipx install certbot-dns-cloudflare

  Then rerun:
    sudo bash pluto-backend/deploy/install-wildcard-tls.sh
MSG
fi

# ── 3. HTTP-01 challenge failed ──────────────────────────────────────────────
if hit "urn:ietf:params:acme:error:unauthorized" || hit "Invalid response from http://" || hit "Fetching http://.*/.well-known/acme-challenge"; then
  FOUND=1
  red "✗ ROOT CAUSE: HTTP-01 challenge could not reach this VPS on port 80."
  cat <<MSG

  Let's Encrypt hit http://<fqdn>/.well-known/acme-challenge/<token> and did
  not receive the expected token. Suspects (fix ONE):

    1. DNS points elsewhere (or wildcard missing)
       → sudo bash pluto-backend/deploy/preflight-dns.sh ${SLUG:-<slug>} ${BASE}
    2. Firewall blocks 80/tcp
       → sudo ufw allow 80/tcp && sudo ufw reload
    3. Cloudflare orange-cloud proxy is stripping /.well-known
       → set DNS-only (grey cloud) for ${SLUG:-<slug>}.${BASE} and *.${BASE#*.}
    4. Nginx has no server block answering ${SLUG:-<slug>}.${BASE} on :80
       → sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
MSG
fi

# ── 3b. IPv6/AAAA challenge failure ─────────────────────────────────────────
if hit "IPv6" || hit "AAAA" || hit "During secondary validation"; then
  FOUND=1
  red "✗ ROOT CAUSE: HTTP-01 likely failed over IPv6/AAAA while IPv4 looked OK."
  cat <<MSG

  Let's Encrypt checks every address it resolves. If ${SLUG:-<slug>}.${BASE}
  has an AAAA record that points somewhere other than this VPS, certbot fails
  even when your local A-record preflight returns 200.

  Fix at your DNS provider:
    1. Delete AAAA for ${SLUG:-<slug>}.${BASE}
    2. Delete wildcard AAAA for *.${BASE} if present
    3. Keep/add A record to this VPS IPv4
    4. Recheck:
       sudo bash pluto-backend/deploy/preflight-dns.sh ${SLUG:-<slug>} ${BASE}
       sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
MSG
fi

# ── 4. Rate limit ────────────────────────────────────────────────────────────
if hit "urn:ietf:params:acme:error:rateLimited" || hit "too many certificates" || hit "duplicate certificate limit"; then
  FOUND=1
  red "✗ ROOT CAUSE: Let's Encrypt rate limit hit."
  cat <<MSG

  You issued too many certs for this domain in the last 7 days (limit: 5 duplicate
  or 50 unique names/week). Fix options:

    • Wait until the rate window resets (see log for exact retry time).
    • Use the staging CA for testing:
        sudo certbot ... --server https://acme-staging-v02.api.letsencrypt.org/directory
    • Switch to a single WILDCARD cert instead of per-slug (needs DNS-01):
        sudo bash pluto-backend/deploy/install-wildcard-tls.sh
MSG
fi

# ── 5. DNS-01 propagation failure ────────────────────────────────────────────
if hit "urn:ietf:params:acme:error:dns" || hit "DNS problem" || hit "NXDOMAIN looking up"; then
  FOUND=1
  red "✗ ROOT CAUSE: DNS-01 challenge could not read the _acme-challenge TXT record."
  cat <<MSG

  The API token likely lacks Zone:DNS:Edit on the correct zone, or the zone
  isn't managed by the DNS provider you configured. Fix:

    • Verify the zone lives at the provider you're using API credentials for:
        dig NS ${BASE#*.} @1.1.1.1
    • Re-check the API token scope:  Zone.DNS Edit + Zone.Zone Read
    • For the timescard.cloud zone (currently on Hostinger), use HTTP-01 instead:
        sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
MSG
fi

# ── 6. Nginx can't load a referenced cert ────────────────────────────────────
if nghit "cannot load certificate" || nghit "no such file or directory.*fullchain.pem"; then
  FOUND=1
  red "✗ ROOT CAUSE: nginx references a cert file that doesn't exist on disk."
  BAD="$(grep -oE '/etc/letsencrypt/live/[^:" )]+' <<<"$NGINX_TAIL" | sort -u | head -3 | tr '\n' ' ')"
  echo   "  Missing paths: ${BAD:-<see /var/log/nginx/error.log>}"
  cat <<MSG

  Fix — issue the cert first, THEN reload nginx:
    sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
    sudo nginx -t && sudo systemctl reload nginx
MSG
fi

# ── 7. Stale per-slug nginx template references missing log_format ───────────
if nghit "unknown log format.*pluto_slug_json"; then
  FOUND=1
  red "✗ ROOT CAUSE: nginx has an old per-slug vhost that references log_format 'pluto_slug_json', but that format is not loaded."
  BAD_VHOSTS="$(grep -Rsl 'pluto_slug_json' /etc/nginx/sites-enabled/pluto-*.conf /etc/nginx/sites-available/pluto-*.conf 2>/dev/null | sort -u | tr '\n' ' ')"
  [[ -n "$BAD_VHOSTS" ]] && echo "  Stale configs: $BAD_VHOSTS"
  cat <<MSG

  Fast fix — disable only Pluto-managed stale enabled vhosts, then rerun go-live:
    sudo grep -Rsl 'pluto_slug_json' /etc/nginx/sites-enabled/pluto-*.conf 2>/dev/null | sudo xargs -r rm -f
    cd /root/backend-joy
    sudo bash pluto-backend/deploy/clean-pull.sh
    sudo bash pluto-backend/deploy/go-live.sh ${SLUG:-<slug>} ${BASE}

  If repo path differs, use rescue:
    curl -fsSL https://plutobaas.lovable.app/downloads/pluto-rescue-go-live.sh -o /tmp/pluto-rescue-go-live.sh
    sudo bash /tmp/pluto-rescue-go-live.sh ${SLUG:-<slug>} ${BASE}
MSG
fi

# ── 8. Certbot UnicodeDecodeError (usually bad credentials file / snap fd) ───
if hit "UnicodeDecodeError" || hit "File not found: /dev/fd"; then
  FOUND=1
  red "✗ ROOT CAUSE: certbot DNS-01 credential handling failed (bad temp fd/encoding or provider mismatch)."
  cat <<MSG

  Your current DNS provider is likely not Cloudflare for this zone, so do not
  keep retrying wildcard DNS-01. Use per-slug HTTP-01 for this slug:

    cd /root/backend-joy
    sudo SKIP_WILDCARD=1 SKIP_VERIFY=1 bash pluto-backend/deploy/full-deploy.sh ${SLUG:-<slug>}
    sudo bash pluto-backend/deploy/issue-per-slug-cert.sh ${SLUG:-<slug>} ${BASE}
    sudo bash pluto-backend/deploy/verify-deploy.sh ${SLUG:-<slug>}
MSG
fi

if (( FOUND == 0 )); then
  yell "No known signature matched in the last 400 log lines."
  yell "Last 30 lines of $LOG:"
  echo
  tail -n 30 "$LOG"
  echo
  yell "Last 20 lines of /var/log/nginx/error.log:"
  echo
  echo "$NGINX_TAIL" | tail -n 20
  echo
  bold "Run these to gather more context:"
  echo "  sudo tail -n 300 $LOG"
  echo "  sudo nginx -t"
  echo "  sudo journalctl -u nginx --since '30 min ago' --no-pager"
  exit 1
fi

green "✓ Diagnosis printed. Follow the 'Fix' section that matches your error."
