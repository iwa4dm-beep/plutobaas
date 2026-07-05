#!/bin/sh
# Container entrypoint — optionally runs migrations before starting the API.
# Enable via AUTO_MIGRATE=1 (default: off).
set -e

MIGRATE_SCRIPT="/app/packages/api/scripts/migrate.mjs"
SERVER_ENTRY="/app/packages/api/dist/server.js"

if [ "${AUTO_MIGRATE:-0}" = "1" ]; then
  if [ ! -f "$MIGRATE_SCRIPT" ]; then
    echo "❌ AUTO_MIGRATE=1 but migrate script not found at $MIGRATE_SCRIPT" >&2
    echo "   Container layout is broken — rebuild the image (docker compose build api)." >&2
    exit 1
  fi
  echo "▶ AUTO_MIGRATE=1 — running migrations before boot"
  node "$MIGRATE_SCRIPT"
  echo "✔ migrations complete"
fi

if [ ! -f "$SERVER_ENTRY" ]; then
  echo "❌ Server entry not found at $SERVER_ENTRY" >&2
  echo "   Build stage likely failed — rebuild the image." >&2
  exit 1
fi

exec node "$SERVER_ENTRY"
