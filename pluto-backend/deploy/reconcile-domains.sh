#!/usr/bin/env bash
# reconcile-domains.sh — Phase D custom-domain auto-wire loop.
#
# Reads verified rows from enterprise.custom_domains via the admin API, then:
#   1. Issues a Let's Encrypt cert (certbot --nginx or webroot HTTP-01).
#   2. Renders /etc/nginx/sites-available/<host>.conf from custom-domain.conf.template.
#   3. Symlinks into sites-enabled and reloads nginx.
#   4. PATCHes the row's nginx_state → live (or failed w/ last_error).
#   5. On rows in state=removing, tears the site down and revokes state.
#
# Designed to run every 1–5 minutes from a systemd timer (see
# systemd/pluto-domain-reconciler.{service,timer}). Idempotent: safe to run
# repeatedly; skips hosts that already match desired state.
#
# Environment:
#   PLUTO_API_BASE          default http://127.0.0.1:8000
#   PLUTO_SERVICE_ROLE_KEY  required — admin bearer for /admin/v1/domains/*
#   NGINX_SITES_DIR         default /etc/nginx/sites-available
#   NGINX_ENABLED_DIR       default /etc/nginx/sites-enabled
#   TEMPLATE                default alongside script
#   CERTBOT_EMAIL           required for first cert issuance
#   RECONCILE_LOG           default /var/log/pluto/reconcile-domains.log
#   DRY_RUN=1               print actions, don't mutate

set -euo pipefail

PLUTO_API_BASE="${PLUTO_API_BASE:-http://127.0.0.1:8000}"
NGINX_SITES_DIR="${NGINX_SITES_DIR:-/etc/nginx/sites-available}"
NGINX_ENABLED_DIR="${NGINX_ENABLED_DIR:-/etc/nginx/sites-enabled}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${TEMPLATE:-$SCRIPT_DIR/nginx/custom-domain.conf.template}"
LOG="${RECONCILE_LOG:-/var/log/pluto/reconcile-domains.log}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true
log()  { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die()  { log "FATAL: $*"; exit 1; }

[[ -n "${PLUTO_SERVICE_ROLE_KEY:-}" ]] || die "PLUTO_SERVICE_ROLE_KEY required"
[[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"
command -v jq       >/dev/null || die "jq required"
command -v curl     >/dev/null || die "curl required"
command -v nginx    >/dev/null || die "nginx required"
command -v certbot  >/dev/null || die "certbot required"

api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-fsS -X "$method" -H "authorization: Bearer $PLUTO_SERVICE_ROLE_KEY" \
              -H "apikey: $PLUTO_SERVICE_ROLE_KEY" -H "content-type: application/json" \
              "$PLUTO_API_BASE$path")
  [[ -n "$body" ]] && args+=(-d "$body")
  curl "${args[@]}"
}

patch_state() {
  local id="$1" state="$2" err="${3:-}"
  local payload
  payload=$(jq -nc --arg s "$state" --arg e "$err" \
              '{nginx_state:$s, cert_last_error:($e|select(length>0))}')
  [[ "$DRY_RUN" = 1 ]] && { log "DRY: PATCH domain $id → $payload"; return 0; }
  api PATCH "/admin/v1/domains/$id" "$payload" >/dev/null || \
    log "warn: failed to patch domain $id state=$state"
}

render_site() {
  local host="$1" slug="$2" out="$NGINX_SITES_DIR/${host}.conf"
  sed -e "s/__HOST__/${host}/g" -e "s/__SLUG__/${slug}/g" "$TEMPLATE" > "$out.tmp"
  mv "$out.tmp" "$out"
  ln -sf "$out" "$NGINX_ENABLED_DIR/${host}.conf"
}

remove_site() {
  local host="$1"
  rm -f "$NGINX_ENABLED_DIR/${host}.conf" "$NGINX_SITES_DIR/${host}.conf"
}

nginx_reload() {
  [[ "$DRY_RUN" = 1 ]] && { log "DRY: nginx -t && systemctl reload nginx"; return 0; }
  if ! nginx -t 2>>"$LOG"; then
    log "ERROR: nginx config test failed — aborting reload"
    return 1
  fi
  systemctl reload nginx
}

issue_cert() {
  local host="$1"
  if [[ -f "/etc/letsencrypt/live/${host}/fullchain.pem" ]]; then
    return 0
  fi
  [[ -n "${CERTBOT_EMAIL:-}" ]] || { log "ERROR: CERTBOT_EMAIL unset, cannot issue $host"; return 1; }
  [[ "$DRY_RUN" = 1 ]] && { log "DRY: certbot --nginx -d $host"; return 0; }
  certbot certonly --nginx -n --agree-tos --email "$CERTBOT_EMAIL" -d "$host" 2>>"$LOG"
}

reconcile_one() {
  local row="$1"
  local id host slug state
  id=$(jq -r '.id'                <<<"$row")
  host=$(jq -r '.hostname'        <<<"$row")
  slug=$(jq -r '.target_slug // ""' <<<"$row")
  state=$(jq -r '.nginx_state'    <<<"$row")

  case "$state" in
    removing)
      log "remove $host"
      remove_site "$host"
      nginx_reload || true
      patch_state "$id" pending "removed"
      ;;
    pending|failed|issuing)
      [[ -z "$slug" ]] && { patch_state "$id" failed "target_slug is empty"; return 0; }
      log "issuing $host → slug=$slug"
      patch_state "$id" issuing ""
      if ! issue_cert "$host"; then
        patch_state "$id" failed "certbot failed"; return 0
      fi
      render_site "$host" "$slug"
      if ! nginx_reload; then
        patch_state "$id" failed "nginx reload failed"; return 0
      fi
      patch_state "$id" live ""
      ;;
    live)
      # Re-render if config drifted (template updated) — cheap idempotent write.
      render_site "$host" "$slug"
      nginx_reload || true
      ;;
  esac
}

main() {
  local rows
  rows=$(api GET "/admin/v1/domains?verified=true&reconcile=1" || true)
  local count
  count=$(jq -r '.domains | length' <<<"$rows" 2>/dev/null || echo 0)
  log "picked $count domain(s) to reconcile"
  local i=0
  while [[ $i -lt $count ]]; do
    local row
    row=$(jq -c ".domains[$i]" <<<"$rows")
    reconcile_one "$row" || log "row $i failed: $(jq -c '.hostname' <<<"$row")"
    i=$((i+1))
  done
}

main "$@"
