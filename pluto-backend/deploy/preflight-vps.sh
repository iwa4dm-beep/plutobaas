#!/usr/bin/env bash
# VPS bootstrap check — confirms docker + docker compose are installed and
# prints exact paths. Exits non-zero if anything is missing.
set -euo pipefail

echo "▶ VPS preflight (uname: $(uname -sr))"

fail=0
need() {
  local bin="$1"
  local path
  if ! path="$(command -v "$bin" 2>/dev/null)"; then
    echo "  ✘ $bin — NOT FOUND on PATH"
    fail=1
    return
  fi
  echo "  ✔ $bin → $path"
}

need docker
need bash
need node || true
need psql || echo "     (psql optional — migrations run inside the container)"

if command -v docker >/dev/null 2>&1; then
  echo -n "  docker version: "; docker --version || fail=1
  if docker compose version >/dev/null 2>&1; then
    echo -n "  docker compose (plugin): "; docker compose version
  elif command -v docker-compose >/dev/null 2>&1; then
    echo "  ⚠ using legacy docker-compose → $(command -v docker-compose)"
    docker-compose --version
  else
    echo "  ✘ docker compose plugin not installed (apt install docker-compose-plugin)"
    fail=1
  fi

  if ! docker info >/dev/null 2>&1; then
    echo "  ✘ docker daemon not reachable (need sudo? user in docker group?)"
    fail=1
  else
    echo "  ✔ docker daemon reachable"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo "✖ preflight FAILED — install missing tools before deploying"
  exit 1
fi
echo "✔ preflight OK"
