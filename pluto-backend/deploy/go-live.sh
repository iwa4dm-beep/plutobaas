#!/usr/bin/env bash
# go-live.sh — one-command deploy for a single slug.
#
# Autodetects the repo top-level, then runs, in order:
#   1. repo/script preflight
#   2. clean-pull.sh          (git sync)
#   3. DNS + HTTP-01 preflight
#   3. full-deploy.sh <slug>  (worker + API nginx; wildcard skipped)
#   4. issue-per-slug-cert.sh <slug> <base>   (HTTP-01 cert)
#   5. verify-deploy.sh <slug>
#
# Usage:
#   sudo bash /path/to/go-live.sh <slug> [base]
#     base defaults to app.timescard.cloud
#
# You can run this from ANYWHERE — even /root — the script finds the repo:
#   sudo bash <(curl -fsS file:///root/backend-joy/pluto-backend/deploy/go-live.sh) <slug>
#
# Exit codes:
#   0   success
#   30  repo not found
#   31  required script missing inside repo
#   32  preflight failed (see stderr)
#   33  clean-pull failed
#   34  full-deploy failed
#   35  cert issuance failed
#   36  final verify failed

set -uo pipefail
SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"

red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

if [[ -z "$SLUG" ]]; then
  red "usage: go-live.sh <slug> [base]"
  exit 2
fi

# ── 1. Autodetect repo root ─────────────────────────────────────────────────
find_repo() {
  # a) explicit override
  if [[ -n "${PLUTO_REPO:-}" && -d "$PLUTO_REPO/pluto-backend/deploy" ]]; then
    echo "$PLUTO_REPO"; return
  fi
  # b) walk up from this script's dir
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [[ -n "$here" ]]; then
    local d="$here"
    for _ in 1 2 3 4 5; do
      if [[ -d "$d/pluto-backend/deploy" && -f "$d/pluto-backend/deploy/full-deploy.sh" ]]; then
        echo "$d"; return
      fi
      d="$(dirname "$d")"
      [[ "$d" == "/" ]] && break
    done
  fi
  # c) common well-known locations
  for cand in /root/backend-joy /root/pluto /opt/pluto/pluto-repo /opt/pluto /srv/pluto ~/pluto ~/backend-joy; do
    [[ -d "$cand/pluto-backend/deploy" ]] && { echo "$cand"; return; }
  done
  # d) filesystem sweep (bounded depth)
  local hit
  hit="$(find /root /opt /srv /home -maxdepth 4 -type d -name pluto-backend 2>/dev/null | head -n1)"
  [[ -n "$hit" ]] && echo "$(dirname "$hit")"
}

REPO="$(find_repo || true)"
if [[ -z "$REPO" || ! -d "$REPO/pluto-backend/deploy" ]]; then
  red "✗ Could not locate the pluto repo."
  cat >&2 <<MSG
  Tried: \$PLUTO_REPO, script parent dirs, /root/backend-joy, /root/pluto,
         /opt/pluto/pluto-repo, /opt/pluto, /srv/pluto, ~, then
         'find /root /opt /srv /home -maxdepth 4 -type d -name pluto-backend'.

  If the repo is elsewhere, rerun with:
      PLUTO_REPO=/absolute/path/to/repo sudo -E bash go-live.sh $SLUG
MSG
  exit 30
fi

bold "▸ Repo:  $REPO"
cd "$REPO"

# ── 2. Verify required scripts exist ────────────────────────────────────────
REQUIRED=(
  "pluto-backend/deploy/preflight-dns.sh"
  "pluto-backend/deploy/clean-pull.sh"
  "pluto-backend/deploy/full-deploy.sh"
  "pluto-backend/deploy/issue-per-slug-cert.sh"
)
missing=()
for f in "${REQUIRED[@]}"; do
  [[ -f "$f" ]] || missing+=("$f")
done
if (( ${#missing[@]} > 0 )); then
  red "✗ Repo is present but these scripts are missing:"
  for m in "${missing[@]}"; do red "    - $m"; done
  red "  Run:  cd $REPO && sudo bash pluto-backend/deploy/clean-pull.sh"
  red "  Then rerun this command."
  exit 31
fi
green "✓ All required scripts present."

# ── 3. clean-pull ───────────────────────────────────────────────────────────
bold "▸ Step 1/5: clean-pull (git sync, preserving runtime data)"
if ! bash pluto-backend/deploy/clean-pull.sh; then
  red "✗ clean-pull failed. Common causes: dirty working tree, no network, wrong remote."
  red "  Inspect:  cd $REPO && git status && git remote -v"
  exit 33
fi

# ── 4. Preflight (DNS + HTTP-01 + nameserver hint) ──────────────────────────
bold "▸ Step 2/5: DNS + HTTP-01 preflight"
if ! bash pluto-backend/deploy/preflight-dns.sh "$SLUG" "$BASE"; then
  red "✗ Preflight failed — fix the printed DNS / port-80 issue above, then rerun."
  exit 32
fi

# ── 5. full-deploy ──────────────────────────────────────────────────────────
bold "▸ Step 3/5: full-deploy $SLUG (skip wildcard TLS; per-slug HTTP-01 will run next)"
if ! SKIP_WILDCARD=1 SKIP_VERIFY=1 bash pluto-backend/deploy/full-deploy.sh "$SLUG"; then
  red "✗ full-deploy failed. Inspect:"
  red "    sudo journalctl -u pluto-sandbox-worker.service -n 200 --no-pager"
  red "    sudo nginx -t && sudo tail -n 100 /var/log/nginx/error.log"
  exit 34
fi

# ── 6. per-slug cert ────────────────────────────────────────────────────────
bold "▸ Step 4/5: issue-per-slug-cert $SLUG $BASE"
if ! bash pluto-backend/deploy/issue-per-slug-cert.sh "$SLUG" "$BASE"; then
  red "✗ Cert issuance failed. Rerun preflight to see the specific block:"
  red "    sudo bash $REPO/pluto-backend/deploy/preflight-dns.sh $SLUG $BASE"
  exit 35
fi

# ── 7. final verify ─────────────────────────────────────────────────────────
bold "▸ Step 5/5: verify-deploy $SLUG"
if ! bash pluto-backend/deploy/verify-deploy.sh "$SLUG"; then
  red "✗ Final verify failed. Diagnose now:"
  red "    sudo bash $REPO/pluto-backend/deploy/diagnose-cert-failure.sh $SLUG $BASE"
  exit 36
fi

echo
green "════════════════════════════════════════════════════════════"
green " ✓ go-live complete: https://${SLUG}.${BASE}"
green "════════════════════════════════════════════════════════════"
