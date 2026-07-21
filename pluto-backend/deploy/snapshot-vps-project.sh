#!/usr/bin/env bash
# snapshot-vps-project.sh — Before analyzing / deploying a new project,
# download the *entire* currently-live project from the VPS as a single
# tarball: frontend site root, per-release history, worker metadata,
# backend repo (source + migrations + .env), and nginx vhost.
#
# The idea: every time you're about to swap `app.timescard.cloud` to a
# new project, you first run this to grab a full backup of what's live,
# so you can diff, roll back, or re-analyze from a known-good baseline.
#
# Usage on the VPS:
#   sudo bash snapshot-vps-project.sh                          # snapshot the primary (app.timescard.cloud)
#   sudo bash snapshot-vps-project.sh <workspaceId-or-slug>    # snapshot a specific project
#   sudo bash snapshot-vps-project.sh --all                    # snapshot every workspace
#
# Env overrides:
#   SITES_ROOT   default /var/lib/pluto/sites
#   REPO         default autodetected pluto repo checkout
#   OUT_DIR      default /var/backups/pluto/snapshots
#   INCLUDE_ENV  default 1 (set to 0 to strip .env files from the tarball)
#
# The output is a single .tar.gz you can `scp` to your laptop:
#   scp root@vps:/var/backups/pluto/snapshots/<name>.tar.gz .

set -euo pipefail

SITES_ROOT="${SITES_ROOT:-/var/lib/pluto/sites}"
OUT_DIR="${OUT_DIR:-/var/backups/pluto/snapshots}"
INCLUDE_ENV="${INCLUDE_ENV:-1}"
STAMP="$(date -u +%Y%m%d-%H%M%SZ)"

log()  { printf "\n▶ %s\n" "$*"; }
pass() { printf "  ✓ %s\n" "$*"; }
warn() { printf "  ⚠ %s\n" "$*" >&2; }
die()  { printf "  ✗ %s\n" "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
mkdir -p "$OUT_DIR"

# ---------- Locate the pluto repo checkout ----------
if [ -z "${REPO:-}" ]; then
  hit=$(find / -maxdepth 6 -type f -name full-deploy.sh -path '*/pluto-backend/deploy/*' 2>/dev/null | head -1 || true)
  [ -n "$hit" ] && REPO=$(dirname "$(dirname "$(dirname "$hit")")")
fi
[ -n "${REPO:-}" ] && [ -d "$REPO/.git" ] && pass "Repo: $REPO" || warn "Repo not autodetected — pass REPO=/path if you want backend source included."

# ---------- Resolve target(s) ----------
resolve_ws_dir() {
  local key="$1"
  if [ -d "$SITES_ROOT/$key" ]; then echo "$SITES_ROOT/$key"; return; fi
  local hit
  hit=$(grep -l "\"slug\"[[:space:]]*:[[:space:]]*\"$key\"" \
        "$SITES_ROOT"/*/current.json "$SITES_ROOT"/*/preview.json 2>/dev/null | head -1 || true)
  [ -n "$hit" ] && dirname "$hit" || return 1
}

TARGETS=()
case "${1:-}" in
  "")
    # Default: whatever the primary symlink points at.
    if [ -L "$SITES_ROOT/_primary/current" ]; then
      real=$(readlink -f "$SITES_ROOT/_primary/current" || true)
      if [ -n "$real" ]; then
        ws=$(dirname "$(dirname "$real")")
        [ -d "$ws" ] && TARGETS+=("$ws")
      fi
    fi
    [ ${#TARGETS[@]} -eq 0 ] && die "No primary project active. Run with a slug or --all."
    ;;
  --all)
    while IFS= read -r d; do
      [ "$(basename "$d")" = "_primary" ] && continue
      TARGETS+=("$d")
    done < <(find "$SITES_ROOT" -mindepth 1 -maxdepth 1 -type d)
    [ ${#TARGETS[@]} -eq 0 ] && die "No workspaces under $SITES_ROOT."
    ;;
  *)
    ws=$(resolve_ws_dir "$1") || die "Cannot find workspace/slug '$1' under $SITES_ROOT"
    TARGETS+=("$ws")
    ;;
esac

# ---------- Build snapshot ----------
NAME="pluto-snapshot-${STAMP}"
STAGE="$(mktemp -d /tmp/${NAME}.XXXX)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/sites" "$STAGE/nginx" "$STAGE/worker" "$STAGE/meta"

log "Snapshotting ${#TARGETS[@]} workspace(s)"
for ws in "${TARGETS[@]}"; do
  name=$(basename "$ws")
  log "  · $name"
  # Copy site tree, resolving symlinks so releases are captured as real files.
  cp -aL "$ws" "$STAGE/sites/$name" 2>/dev/null || cp -a "$ws" "$STAGE/sites/$name"
  # Record manifests separately for quick diff.
  for m in current.json preview.json; do
    [ -f "$ws/$m" ] && cp "$ws/$m" "$STAGE/meta/${name}.${m}"
  done
done

# Primary pointer
if [ -L "$SITES_ROOT/_primary/current" ]; then
  readlink -f "$SITES_ROOT/_primary/current" > "$STAGE/meta/_primary.target" || true
  [ -f "$SITES_ROOT/_primary/current.json" ] && cp "$SITES_ROOT/_primary/current.json" "$STAGE/meta/_primary.current.json"
fi

# Worker code + service unit + repair history (drives auto-heal)
if [ -d "$REPO/pluto-backend/sandbox-worker" ]; then
  rsync -a --exclude 'node_modules' --exclude 'sites' --exclude '.slug-secrets' \
    "$REPO/pluto-backend/sandbox-worker/" "$STAGE/worker/"
  for f in "$REPO/pluto-backend/sandbox-worker/.repair-history.json"; do
    [ -f "$f" ] && cp "$f" "$STAGE/worker/.repair-history.json"
  done
fi
[ -f /etc/systemd/system/pluto-sandbox-worker.service ] && \
  cp /etc/systemd/system/pluto-sandbox-worker.service "$STAGE/worker/systemd.service"

# Nginx vhosts touching pluto/app.timescard.cloud
for d in /etc/nginx/sites-available /etc/nginx/sites-enabled; do
  [ -d "$d" ] || continue
  mkdir -p "$STAGE/nginx/$(basename "$d")"
  find "$d" -maxdepth 1 -type f -o -type l | while read -r f; do
    if grep -qE 'pluto|app\.timescard\.cloud' "$f" 2>/dev/null; then
      cp -L "$f" "$STAGE/nginx/$(basename "$d")/$(basename "$f")"
    fi
  done
done

# Backend repo source (respects .gitignore so node_modules etc. are skipped)
if [ -n "${REPO:-}" ] && [ -d "$REPO/.git" ]; then
  log "Archiving backend repo @ $REPO"
  git -C "$REPO" rev-parse HEAD > "$STAGE/meta/repo.HEAD" 2>/dev/null || true
  git -C "$REPO" status --short > "$STAGE/meta/repo.status" 2>/dev/null || true
  git -C "$REPO" archive --format=tar HEAD | gzip -9 > "$STAGE/repo-tracked.tar.gz"
  # Migrations + env examples explicitly (in case they were untracked)
  [ -d "$REPO/pluto-backend/migrations" ] && \
    tar -C "$REPO/pluto-backend" -czf "$STAGE/migrations.tar.gz" migrations
fi

# .env files (opt-in; DO NOT copy if INCLUDE_ENV=0)
if [ "$INCLUDE_ENV" = "1" ]; then
  mkdir -p "$STAGE/env"
  for candidate in \
      "$REPO/.env" "$REPO/.env.local" "$REPO/.env.production" \
      "$REPO/pluto-backend/.env" "$REPO/pluto-backend/sandbox-worker/.env" \
      /etc/pluto/env; do
    [ -f "$candidate" ] && cp "$candidate" "$STAGE/env/$(echo "$candidate" | tr '/' '_' )"
  done
  pass ".env files included (set INCLUDE_ENV=0 to skip)."
else
  warn ".env files SKIPPED (INCLUDE_ENV=0)."
fi

# Postgres schema dump (best-effort; needs DATABASE_URL in env)
if command -v pg_dump >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  log "Dumping Postgres schema"
  pg_dump --schema-only --no-owner --no-privileges "$DATABASE_URL" \
    > "$STAGE/meta/schema.sql" 2>/dev/null && pass "schema.sql written" \
    || warn "pg_dump failed — skipping"
fi

# Manifest describing what's in the tarball
cat > "$STAGE/SNAPSHOT.txt" <<EOF
Pluto VPS project snapshot
Taken:        $(date -u +%FT%TZ)
Host:         $(hostname -f 2>/dev/null || hostname)
Sites root:   $SITES_ROOT
Workspaces:   ${#TARGETS[@]}
Repo:         ${REPO:-<not found>}
Repo HEAD:    $(git -C "${REPO:-/nonexistent}" rev-parse --short HEAD 2>/dev/null || echo n/a)
Includes:     sites/  worker/  nginx/  meta/  $( [ "$INCLUDE_ENV" = 1 ] && echo env/ ) $( [ -f "$STAGE/repo-tracked.tar.gz" ] && echo repo-tracked.tar.gz )
EOF
for ws in "${TARGETS[@]}"; do echo "  - $(basename "$ws")" >> "$STAGE/SNAPSHOT.txt"; done

# ---------- Package ----------
OUT="$OUT_DIR/${NAME}.tar.gz"
log "Compressing → $OUT"
tar -C "$STAGE" -czf "$OUT" .
SIZE=$(du -h "$OUT" | cut -f1)
sha=$(sha256sum "$OUT" | cut -d' ' -f1)

cat <<EOF

════════════════════════════════════════════════════════════════
✅ Snapshot complete
   File:   $OUT
   Size:   $SIZE
   SHA256: $sha

Download to your laptop:
   scp root@$(hostname -f 2>/dev/null || hostname):$OUT ./

Peek at contents:
   tar tzf $OUT | less

Restore later (careful — overwrites live state):
   sudo tar xzf $OUT -C /tmp/pluto-restore/
════════════════════════════════════════════════════════════════
EOF
