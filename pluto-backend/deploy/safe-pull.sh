#!/usr/bin/env bash
# Safe pull for the VPS checkout: stash any local edits, run a
# fast-forward pull, and restore only files that the operator explicitly
# whitelists (default: nothing, i.e. adopt upstream). Prevents the
# common "your local changes would be overwritten" abort.
#
# Usage (from repo root):
#   bash deploy/safe-pull.sh
#   KEEP='migrations/0037_project_usage_and_quotas.sql other/file.txt' bash deploy/safe-pull.sh
#
# Behaviour:
#   1. `git stash push -u` covering the whole tree (only if dirty).
#   2. `git pull --ff-only`.
#   3. For every path in $KEEP, `git checkout stash@{0} -- <path>`.
#   4. Drops the stash if it is now empty; otherwise keeps it for review.

set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
KEEP="${KEEP:-}"

echo "▶ Repo: $(pwd)"
echo "▶ Branch: $(git rev-parse --abbrev-ref HEAD)"

DIRTY=0
if ! git diff --quiet || ! git diff --cached --quiet || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  DIRTY=1
fi

STASH_REF=""
if [ $DIRTY -eq 1 ]; then
  MSG="safe-pull-$(date +%s)"
  echo "▶ Local changes detected — stashing as: $MSG"
  git stash push -u -m "$MSG" >/dev/null
  STASH_REF="$(git stash list | head -1 | cut -d: -f1)"
  echo "  stash ref: $STASH_REF"
else
  echo "✓ Working tree clean."
fi

echo "▶ git pull --ff-only"
if ! git pull --ff-only; then
  echo "✗ Pull failed. Your stash (if any) is at: $STASH_REF"
  exit 1
fi

if [ -n "$STASH_REF" ] && [ -n "$KEEP" ]; then
  echo "▶ Restoring whitelisted paths from stash:"
  for p in $KEEP; do
    if git checkout "$STASH_REF" -- "$p" 2>/dev/null; then
      echo "   ✓ restored $p"
    else
      echo "   ⚠ could not restore $p (was it in the stash?)"
    fi
  done
fi

if [ -n "$STASH_REF" ]; then
  echo "▶ Stash preserved for review: $STASH_REF"
  echo "  Inspect:  git stash show -p $STASH_REF"
  echo "  Drop:     git stash drop  $STASH_REF"
fi

echo "✓ safe-pull complete."
