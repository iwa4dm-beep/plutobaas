#!/usr/bin/env bash
# LOCAL machine: pull last N backup artifacts from VPS via rsync,
# then prune older files locally so disk stays bounded.
#
# Usage:
#   VPS=root@1.2.3.4  REMOTE_DIR=/var/backups/pluto  LOCAL_DIR=~/pluto-backups  KEEP=7 \
#     bash pull-latest.sh
#
# Env:
#   VPS         ssh target (user@host)                REQUIRED
#   REMOTE_DIR  backup dir on VPS                     default /var/backups/pluto
#   LOCAL_DIR   where to store on local machine       default ~/pluto-backups
#   KEEP        keep newest N of each artifact type   default 7
#   SSH_KEY     private key path (optional)
set -euo pipefail

: "${VPS:?VPS=user@host লাগবে}"
REMOTE_DIR="${REMOTE_DIR:-/var/backups/pluto}"
LOCAL_DIR="${LOCAL_DIR:-$HOME/pluto-backups}"
KEEP="${KEEP:-7}"
SSH_OPT=""; [ -n "${SSH_KEY:-}" ] && SSH_OPT="-e 'ssh -i $SSH_KEY'"

mkdir -p "$LOCAL_DIR"/{zip,db,config,manifest}

echo "==> discovering newest $KEEP of each type on $VPS:$REMOTE_DIR"
# Build include list from the remote so we transfer only the newest N.
list_newest() {
  local pattern="$1"
  ssh ${SSH_KEY:+-i "$SSH_KEY"} "$VPS" \
    "ls -1t $REMOTE_DIR/$pattern 2>/dev/null | head -n $KEEP"
}

RSYNC_OPTS=(-avhP --partial --append-verify --chmod=Du=rwx,Fu=rw,go=)
[ -n "${SSH_KEY:-}" ] && RSYNC_OPTS+=(-e "ssh -i $SSH_KEY")

sync_group() {
  local subdir="$1" pattern="$2"
  local files; files=$(list_newest "$pattern") || true
  [ -z "$files" ] && { echo "   (none for $pattern)"; return; }
  echo "==> syncing $(echo "$files" | wc -l) file(s) → $LOCAL_DIR/$subdir"
  # rsync each file individually so we get atomic + resumable transfers
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    rsync "${RSYNC_OPTS[@]}" "$VPS:$f"      "$LOCAL_DIR/$subdir/"
    rsync "${RSYNC_OPTS[@]}" "$VPS:$f.sha256" "$LOCAL_DIR/$subdir/" 2>/dev/null || true
  done <<< "$files"
}

sync_group zip      "pluto-complete-*.zip.enc"
sync_group zip      "pluto-complete-*.zip"
sync_group db       "pluto-db-*.sql.gz*"
sync_group config   "pluto-config-*.tar.gz*"
sync_group manifest "manifest-*.json"

echo "==> local prune (keep newest $KEEP per type)"
prune_local() {
  local dir="$1" pattern="$2"
  ls -1t "$LOCAL_DIR/$dir"/$pattern 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
    echo "   rm $old"; rm -f "$old" "$old.sha256"
  done
}
prune_local zip      "pluto-complete-*.zip*"
prune_local db       "pluto-db-*.sql.gz*"
prune_local config   "pluto-config-*.tar.gz*"
prune_local manifest "manifest-*.json"

echo "==> verifying checksums locally"
fail=0
for f in "$LOCAL_DIR"/*/*.sha256; do
  [ -f "$f" ] || continue
  (cd "$(dirname "$f")" && sha256sum -c "$(basename "$f")" >/dev/null 2>&1) \
    && echo "   ✔ $(basename "$f")" \
    || { echo "   ✘ MISMATCH: $f"; fail=$((fail+1)); }
done
[ "$fail" -eq 0 ] || { echo "!! $fail checksum failure(s)"; exit 1; }

echo "==> done. local usage:"
du -sh "$LOCAL_DIR"/* 2>/dev/null || true
