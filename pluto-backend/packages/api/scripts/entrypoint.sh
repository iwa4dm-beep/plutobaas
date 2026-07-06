#!/bin/sh
# Container entrypoint — optionally runs migrations before starting the API.
# Enable via AUTO_MIGRATE=1 (default: off).
set -e

MIGRATE_SCRIPT="/app/packages/api/scripts/migrate.mjs"
BOOTSTRAP_SCRIPT="/app/packages/api/scripts/bootstrap-auth-shim.mjs"
SERVER_ENTRY="/app/packages/api/dist/server.js"

# Always ensure the auth.* compatibility shim exists before the API boots.
# Migrations 0016+ reference auth.uid() / auth.role() / auth.jwt(); without
# these functions the API would crash on the first RLS-guarded query.
if [ -f "$BOOTSTRAP_SCRIPT" ]; then
  echo "▶ bootstrapping auth.* compatibility shim"
  node "$BOOTSTRAP_SCRIPT"
else
  echo "⚠ bootstrap script missing at $BOOTSTRAP_SCRIPT — skipping shim" >&2
fi

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
