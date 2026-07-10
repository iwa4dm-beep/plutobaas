#!/usr/bin/env bash
# Verify a downloaded ZIP/dump/config against its manifest.json.
# Usage: bash verify-manifest.sh /path/to/manifest-<STAMP>.json
set -euo pipefail
MAN="${1:?path to manifest-*.json required}"
[ -f "$MAN" ] || { echo "not found: $MAN"; exit 1; }
command -v jq >/dev/null || { echo "install jq"; exit 1; }

fail=0
for kind in zip db config; do
  path=$(jq -r ".artifacts.$kind.path"   "$MAN")
  want=$(jq -r ".artifacts.$kind.sha256" "$MAN")
  [ -z "$path" ] || [ "$path" = "null" ] && continue
  # try same path, then basename in cwd
  cand="$path"; [ -f "$cand" ] || cand="./$(basename "$path")"
  if [ ! -f "$cand" ]; then echo "   ⚠ missing: $kind ($path)"; continue; fi
  got=$(sha256sum "$cand" | awk '{print $1}')
  if [ "$got" = "$want" ]; then
    echo "   ✔ $kind  $cand"
  else
    echo "   ✘ $kind MISMATCH  $cand"; fail=$((fail+1))
  fi
done
exit "$fail"
