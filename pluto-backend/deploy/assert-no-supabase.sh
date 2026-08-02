#!/usr/bin/env bash
# assert-no-supabase.sh
# ---------------------------------------------------------------
# Fails (exit 1) if any file under dist/ still references
# supabase.co / supabase.in — including dns-prefetch/preconnect
# links in index.html and service-worker precache manifests.
#
# Usage:
#   bash pluto-backend/deploy/assert-no-supabase.sh [dist_dir]
set -euo pipefail

declare -a TARGETS=("${1:-dist}")
if [[ $# -gt 0 ]]; then shift; fi
for target in "$@"; do
  [[ -e "$target" ]] && TARGETS+=("$target")
done

die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
pass() { printf '\033[1;32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

[[ -d "${TARGETS[0]}" ]] || die "dist dir not found: ${TARGETS[0]}"

FAIL=0
mapfile -t URL_HITS < <(grep -RIln -E 'https?://[a-z0-9-]+\.supabase\.(co|in)' "${TARGETS[@]}" 2>/dev/null || true)
if [[ ${#URL_HITS[@]} -gt 0 ]]; then
  warn "Supabase URLs still present in deployable output:"
  printf '   %s\n' "${URL_HITS[@]}" >&2
  FAIL=1
fi

if grep -RIln -E 'supabase\.(co|in)' "${TARGETS[@]}" 2>/dev/null | grep -E '\.(html?|js|mjs|cjs)(:|$)' >/dev/null; then
  warn "Supabase host references remain in deployable HTML/JavaScript."
  FAIL=1
fi

if grep -RIln -E '"eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_.-]{20,}"' "${TARGETS[@]}" 2>/dev/null; then
  warn "Hardcoded Supabase-style anon JWT still exists in deployable output."
  FAIL=1
fi

if [[ $FAIL -ne 0 ]]; then
  die "cutover guard FAILED — deployable output still contains Supabase references"
fi

pass "no Supabase references found in: ${TARGETS[*]}"
