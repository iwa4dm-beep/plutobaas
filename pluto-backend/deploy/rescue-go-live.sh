#!/usr/bin/env bash
# rescue-go-live.sh — path-independent VPS rescue launcher.
#
# Use this when an operator does NOT know where the Pluto repo is on the VPS or
# the newer go-live/diagnose scripts are missing from the current checkout.
# It finds the repo, syncs it from git, verifies required scripts, then delegates
# to go-live.sh for the real deploy + per-slug HTTP-01 certificate flow.
#
# Usage:
#   sudo bash rescue-go-live.sh <slug> [base]
#   PLUTO_REPO=/actual/repo sudo -E bash rescue-go-live.sh <slug> [base]

set -uo pipefail

SLUG="${1:-}"
BASE="${2:-app.timescard.cloud}"
REMOTE="${REMOTE:-origin}"

red()   { printf "\033[31m%s\033[0m\n" "$*" >&2; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yell()  { printf "\033[33m%s\033[0m\n" "$*"; }
bold()  { printf "\033[1m%s\033[0m\n" "$*"; }

if [[ -z "$SLUG" ]]; then
  red "usage: rescue-go-live.sh <slug> [base]"
  exit 2
fi
if [[ "$(id -u)" != "0" ]]; then
  red "run as root: sudo bash rescue-go-live.sh $SLUG $BASE"
  exit 2
fi

find_repo() {
  if [[ -n "${PLUTO_REPO:-}" && -d "$PLUTO_REPO/.git" && -d "$PLUTO_REPO/pluto-backend" ]]; then
    echo "$PLUTO_REPO"; return
  fi

  # If the script itself lives inside the repo, walk upward first.
  local here=""
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  if [[ -n "$here" ]]; then
    local d="$here"
    for _ in 1 2 3 4 5 6; do
      if [[ -d "$d/.git" && -d "$d/pluto-backend" ]]; then echo "$d"; return; fi
      d="$(dirname "$d")"
      [[ "$d" == "/" ]] && break
    done
  fi

  # Common VPS paths seen across installs.
  local cand
  for cand in \
    /root/backend-joy /root/pluto /root/pluto-repo /root/backend \
    /opt/pluto/pluto-repo /opt/pluto /srv/pluto /home/pluto/pluto-repo; do
    [[ -d "$cand/.git" && -d "$cand/pluto-backend" ]] && { echo "$cand"; return; }
  done

  # Bounded sweep — deliberately avoids a full filesystem scan.
  local hit=""
  hit="$(find /root /opt /srv /home -maxdepth 7 -type d -name pluto-backend 2>/dev/null | head -n1 || true)"
  if [[ -n "$hit" && -d "$(dirname "$hit")/.git" ]]; then
    echo "$(dirname "$hit")"; return
  fi

  # Fallback: find a known deploy script and infer the repo root.
  hit="$(find /root /opt /srv /home -maxdepth 8 -type f -path '*/pluto-backend/deploy/full-deploy.sh' 2>/dev/null | head -n1 || true)"
  if [[ -n "$hit" ]]; then
    echo "$(dirname "$(dirname "$(dirname "$hit")")")"; return
  fi
}

REPO="$(find_repo || true)"
if [[ -z "$REPO" || ! -d "$REPO/.git" || ! -d "$REPO/pluto-backend" ]]; then
  red "✗ Pluto repo পাওয়া যায়নি — আপনি ভুল path ধরেছেন, তাই /root/backend-joy/... কাজ করেনি।"
  cat >&2 <<MSG

এখন VPS-এ repo path বের করুন:
  sudo find /root /opt /srv /home -maxdepth 8 -type f -path '*/pluto-backend/deploy/full-deploy.sh' 2>/dev/null

যে path পাবেন, তার repo root দিয়ে rerun করুন:
  PLUTO_REPO=/FOUND/REPO/ROOT sudo -E bash /tmp/pluto-rescue-go-live.sh ${SLUG} ${BASE}

যদি কিছুই না আসে, platform repo VPS-এ clone নেই — আগে repo clone/restore করতে হবে।
MSG
  exit 30
fi

bold "▸ Repo found: $REPO"
cd "$REPO" || exit 31

if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  red "✗ $REPO is a git checkout, but remote '$REMOTE' নেই."
  git remote -v >&2 || true
  exit 32
fi

BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
[[ "$BRANCH" == "HEAD" || -z "$BRANCH" ]] && BRANCH="main"
bold "▸ Syncing repo: $REMOTE/$BRANCH"

# Prefer the project's safe cleaner if already present; otherwise use a minimal
# stash + ff-only pull so old VPS checkouts can receive the missing scripts.
if [[ -f pluto-backend/deploy/clean-pull.sh ]]; then
  if ! REPO="$REPO" BRANCH="$BRANCH" REMOTE="$REMOTE" bash pluto-backend/deploy/clean-pull.sh; then
    red "✗ clean-pull failed. Trying minimal git sync fallback..."
    git fetch --all --prune --tags || exit 33
    git reset --hard "$REMOTE/$BRANCH" || exit 33
  fi
else
  if ! git diff --quiet || ! git diff --cached --quiet || [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
    git stash push -u -m "rescue-go-live-$(date +%s)" >/dev/null || true
  fi
  git fetch --all --prune --tags || exit 33
  git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -B "$BRANCH" "$REMOTE/$BRANCH" || true
  git reset --hard "$REMOTE/$BRANCH" || exit 33
fi

chmod +x pluto-backend/deploy/*.sh 2>/dev/null || true

REQUIRED=(
  pluto-backend/deploy/go-live.sh
  pluto-backend/deploy/preflight-dns.sh
  pluto-backend/deploy/full-deploy.sh
  pluto-backend/deploy/issue-per-slug-cert.sh
  pluto-backend/deploy/verify-deploy.sh
)
missing=()
for f in "${REQUIRED[@]}"; do [[ -f "$f" ]] || missing+=("$f"); done
if (( ${#missing[@]} > 0 )); then
  red "✗ Git sync হলো, কিন্তু required scripts এখনো missing:"
  for f in "${missing[@]}"; do red "  - $f"; done
  cat >&2 <<MSG

সম্ভাব্য কারণ: VPS checkout ভুল branch/repo থেকে চলছে। দেখুন:
  cd $REPO && git remote -v && git branch --show-current && git log -1 --oneline
MSG
  exit 34
fi

bold "▸ Running go-live for ${SLUG}.${BASE}"
exec bash pluto-backend/deploy/go-live.sh "$SLUG" "$BASE"
