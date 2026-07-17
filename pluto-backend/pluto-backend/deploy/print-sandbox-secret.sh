#!/usr/bin/env bash
# Compatibility wrapper for operators who run this from inside pluto-backend as:
#   sudo bash pluto-backend/deploy/print-sandbox-secret.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
exec bash "$HERE/../../deploy/print-sandbox-secret.sh" "$@"