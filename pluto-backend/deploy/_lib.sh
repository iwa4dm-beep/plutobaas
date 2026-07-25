#!/usr/bin/env bash
# _lib.sh — shared helpers for deploy/repair scripts.
#
# Source at the top of any script:
#   set -euo pipefail
#   . "$(dirname "$0")/_lib.sh"
#
# Provides:
#   die MSG           — print red error and exit 1
#   warn MSG          — print yellow warning (non-fatal)
#   info / ok         — informational output
#   require_root      — abort unless EUID=0 (or sudo -n works)
#   require_cmd A B…  — abort if any command is missing, listing all missing
#   require_var A B…  — abort if any env var is empty, listing all missing
#   require_file P    — abort if file/dir missing
#   run "label" cmd…  — run a command, show label, capture failure with friendly hint
#   on_err_trap       — install ERR trap that reports the failing line & command
#
# Idempotent: safe to source multiple times.

# shellcheck shell=bash
[ -n "${__PLUTO_LIB_SH:-}" ] && return 0
__PLUTO_LIB_SH=1

# ── ANSI (auto-disabled when not a TTY) ──────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  _c_red=$'\033[1;31m'; _c_yel=$'\033[1;33m'; _c_grn=$'\033[1;32m'
  _c_blu=$'\033[1;36m'; _c_dim=$'\033[2m';    _c_rst=$'\033[0m'
else
  _c_red=""; _c_yel=""; _c_grn=""; _c_blu=""; _c_dim=""; _c_rst=""
fi

die()  { printf '%s✗ %s%s\n' "$_c_red" "$*" "$_c_rst" >&2; exit 1; }
warn() { printf '%s! %s%s\n' "$_c_yel" "$*" "$_c_rst" >&2; }
info() { printf '%s▶ %s%s\n' "$_c_blu" "$*" "$_c_rst"; }
ok()   { printf '%s✓ %s%s\n' "$_c_grn" "$*" "$_c_rst"; }
dim()  { printf '%s%s%s\n'   "$_c_dim" "$*" "$_c_rst"; }

require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
      return 0
    fi
    die "This script must run as root. Try: sudo bash $0 $*"
  fi
}

require_cmd() {
  local missing=()
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required command(s): ${missing[*]}. Install them and retry."
  fi
}

require_var() {
  local missing=()
  for v in "$@"; do
    if [ -z "${!v:-}" ]; then missing+=("$v"); fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required env var(s): ${missing[*]}. Set them and retry (e.g. VAR=value $0 …)."
  fi
}

require_file() {
  for p in "$@"; do
    [ -e "$p" ] || die "Expected file/dir not found: $p"
  done
}

# Human-friendly wrapper: `run "Restart nginx" systemctl reload nginx`
run() {
  local label="$1"; shift
  info "$label"
  if ! "$@"; then
    local rc=$?
    warn "Command failed (exit $rc): $*"
    die  "Step failed: $label — see the message above for the underlying error."
  fi
}

# Install once from a script:
#   trap on_err_trap ERR
on_err_trap() {
  local rc=$?
  local line="${BASH_LINENO[0]:-?}"
  local cmd="${BASH_COMMAND:-?}"
  printf '%s✗ %s:%s failed (exit %s) → %s%s\n' \
    "$_c_red" "${BASH_SOURCE[1]:-$0}" "$line" "$rc" "$cmd" "$_c_rst" >&2
  exit "$rc"
}
