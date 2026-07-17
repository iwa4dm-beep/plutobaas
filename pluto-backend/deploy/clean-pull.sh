#!/usr/bin/env bash
# clean-pull.sh — Force the VPS checkout to exactly match GitHub (origin/<branch>).
#
# What it does:
#   1. Autodetects the pluto repo path on this VPS (or use REPO=/path).
#   2. Backs up any local uncommitted changes into a timestamped tarball
#      under /var/backups/pluto/ (safety net — never destroyed silently).
#   3. `git fetch --all --prune` then `git reset --hard origin/<branch>`.
#   4. `git clean -fdx` — removes untracked files/dirs INCLUDING ignored ones,
#      so node_modules, build artefacts, and stray scripts are wiped.
#      Preserves runtime state we must NOT nuke (see KEEP_PATHS below).
#   5. Marks every deploy script executable.
#
# Usage (paste on the VPS as root):
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/pluto-backend/deploy/clean-pull.sh | sudo bash
# or, if the repo is already cloned somewhere:
#   sudo REPO=/root/pluto BRANCH=main bash /root/pluto/pluto-backend/deploy/clean-pull.sh
#
# Env overrides:
#   REPO       - path to the git checkout (autodetected if unset)
#   BRANCH     - branch to sync (default: current branch, or `main`)
#   REMOTE     - git remote (default: origin)
#   KEEP_PATHS - space-separated extra paths to preserve during `git clean`

set -euo pipefail

log()  { printf "\n▶ %s\n" "$*"; }
pass() { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*" >&2; }
die()  { printf "  ✗ %s\n" "$*" >&2; exit 1; }

# ---------- 1. Locate the repo ----------
if [ -z "${REPO:-}" ]; then
  log "Locating pluto repo on this VPS"
  CANDIDATES=$(find / -maxdepth 6 -type f -name full-deploy.sh -path '*/pluto-backend/deploy/*' 2>/dev/null | head -5 || true)
  if [ -z "$CANDIDATES" ]; then
    die "Could not autodetect the repo. Pass REPO=/path/to/checkout explicitly."
  fi
  REPO=$(dirname "$(dirname "$(dirname "$(echo "$CANDIDATES" | head -1)")")")
fi

[ -d "$REPO/.git" ] || die "$REPO is not a git checkout (missing .git). Pass REPO=/correct/path."
cd "$REPO"
pass "Repo: $REPO"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)}"
[ "$BRANCH" = "HEAD" ] && BRANCH="main"
pass "Remote/branch: $REMOTE/$BRANCH"

git remote get-url "$REMOTE" >/dev/null 2>&1 || die "Remote '$REMOTE' is not configured in $REPO."

# ---------- 2. Backup local state ----------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/var/backups/pluto"
mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/pre-clean-pull-${STAMP}.tar.gz"

if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  log "Local edits detected — backing up dirty tree"
  # shellcheck disable=SC2046
  tar -czf "$BACKUP_FILE" \
      $(git ls-files -m -o --exclude-standard 2>/dev/null | head -500) 2>/dev/null || true
  if [ -s "$BACKUP_FILE" ]; then
    pass "Backup: $BACKUP_FILE"
  else
    rm -f "$BACKUP_FILE"
    warn "Nothing to back up (files may have vanished mid-scan)."
  fi
else
  pass "Working tree clean — no backup needed."
fi

# ---------- 3. Fetch + hard reset ----------
log "Fetching latest from $REMOTE"
git fetch --all --prune --tags

log "Hard-resetting to $REMOTE/$BRANCH"
git checkout -q "$BRANCH" 2>/dev/null || git checkout -q -B "$BRANCH" "$REMOTE/$BRANCH"
git reset --hard "$REMOTE/$BRANCH"
NEW_SHA=$(git rev-parse --short HEAD)
pass "HEAD is now $NEW_SHA on $BRANCH"

# ---------- 4. Clean untracked/ignored, but preserve runtime state ----------
# NEVER delete these on the VPS — they carry runtime state or system config:
DEFAULT_KEEP=(
  ".env"
  ".env.local"
  ".env.production"
  "pluto-backend/sandbox-worker/sites/"
  "pluto-backend/sandbox-worker/.slug-secrets/"
  "pluto-backend/sandbox-worker/.repair-history.json"
  "pluto-backend/sandbox-worker/node_modules/"
  "var/"
  "logs/"
)
EXTRA_KEEP=(${KEEP_PATHS:-})
EXCLUDES=()
for p in "${DEFAULT_KEEP[@]}" "${EXTRA_KEEP[@]}"; do
  EXCLUDES+=(-e "$p")
done

log "Cleaning untracked & ignored files (preserving runtime state)"
git clean -fdx "${EXCLUDES[@]}"
pass "Working tree matches $REMOTE/$BRANCH."

# ---------- 5. Make deploy scripts executable ----------
if [ -d pluto-backend/deploy ]; then
  chmod +x pluto-backend/deploy/*.sh 2>/dev/null || true
  pass "Marked deploy scripts executable."
fi

# ---------- 6. Summary ----------
cat <<EOF

════════════════════════════════════════════════════════════════
✅ Clean pull complete
   Repo:    $REPO
   Branch:  $BRANCH @ $NEW_SHA
   Backup:  ${BACKUP_FILE:-<none>}

Next commands you probably want to run:

   sudo bash $REPO/pluto-backend/deploy/full-deploy.sh
   # or, for a first-time wildcard platform install:
   sudo CF_API_TOKEN=... UPSTREAM=https://<ref>.supabase.co \\
        SERVICE_KEY=... ACME_EMAIL=admin@timescard.cloud \\
        SLUG=<optional-slug> \\
        bash $REPO/pluto-backend/deploy/setup-wildcard-subdomains.sh
════════════════════════════════════════════════════════════════
EOF
