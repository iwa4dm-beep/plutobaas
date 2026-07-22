#!/usr/bin/env bash
# extract-supabase-schema.sh
# ---------------------------------------------------------------
# Extracts schema + RLS from a Supabase project and produces a
# Pluto-compatible tenant migration bundle.
#
# Usage:
#   bash extract-supabase-schema.sh <SUPABASE_DB_URL> <slug>
#
# Example:
#   bash extract-supabase-schema.sh \
#     "postgres://postgres:PASS@db.vunjeufiiwaqxrsogudg.supabase.co:5432/postgres" \
#     timesn
#
# Output:
#   /tmp/pluto-migrations/<slug>/0001_schema.sql
#   /tmp/pluto-migrations/<slug>/0002_rls.sql
#   /tmp/pluto-migrations/<slug>/README.md
# ---------------------------------------------------------------
set -euo pipefail

DB_URL="${1:-}"
SLUG="${2:-}"

if [[ -z "$DB_URL" || -z "$SLUG" ]]; then
  echo "Usage: $0 <SUPABASE_DB_URL> <slug>" >&2
  exit 2
fi

command -v pg_dump >/dev/null || { echo "✗ pg_dump not installed. apt-get install postgresql-client" >&2; exit 1; }

OUT="/tmp/pluto-migrations/$SLUG"
mkdir -p "$OUT"
echo "→ Output dir: $OUT"

echo "→ Dumping schema (public + auth.users only, no owners)…"
pg_dump "$DB_URL" \
  --schema-only --no-owner --no-privileges --no-comments \
  --schema=public \
  > "$OUT/0001_schema.raw.sql"

echo "→ Translating Supabase-isms → Pluto equivalents…"
# auth.uid()   -> current_setting('pluto.user_id')::uuid
# auth.role()  -> current_setting('pluto.role')
# auth.jwt()   -> current_setting('pluto.jwt')::jsonb   (best-effort)
# Drop extension DDL Pluto already provides.
sed -E \
  -e "s#auth\\.uid\\(\\)#current_setting('pluto.user_id', true)::uuid#g" \
  -e "s#auth\\.role\\(\\)#current_setting('pluto.role', true)#g" \
  -e "s#auth\\.jwt\\(\\)#current_setting('pluto.jwt', true)::jsonb#g" \
  -e '/^CREATE EXTENSION/d' \
  -e '/^COMMENT ON EXTENSION/d' \
  "$OUT/0001_schema.raw.sql" > "$OUT/0001_schema.sql"
rm "$OUT/0001_schema.raw.sql"

echo "→ Extracting RLS policies separately for review…"
{
  echo "-- RLS policies (extracted from schema dump for review)"
  grep -E '^(ALTER TABLE .* ENABLE ROW LEVEL SECURITY|CREATE POLICY)' "$OUT/0001_schema.sql" || true
} > "$OUT/0002_rls_summary.sql"

cat > "$OUT/README.md" <<EOF
# Pluto Migration Bundle — $SLUG

Extracted from Supabase at $(date -Iseconds).

## Files
- \`0001_schema.sql\` — Tables, functions, indexes, RLS policies (translated).
- \`0002_rls_summary.sql\` — RLS policy list only, for quick review.

## Translations applied
| Supabase        | Pluto                                          |
|-----------------|------------------------------------------------|
| \`auth.uid()\`  | \`current_setting('pluto.user_id', true)::uuid\` |
| \`auth.role()\` | \`current_setting('pluto.role', true)\`         |
| \`auth.jwt()\`  | \`current_setting('pluto.jwt', true)::jsonb\`   |

## What is NOT migrated
- \`auth.users\` rows (password hashes) — users must reset passwords, or write a bcrypt-compatible importer.
- Storage buckets/objects — separate flow.
- Edge Functions — manually port to Pluto Edge Functions.
- Realtime publications — reconfigure via Pluto Dashboard.

## Push to Pluto
Option A (recommended): Pluto Dashboard → Auto Deploy → Migrations → paste \`0001_schema.sql\`.
Option B: place in \`pluto-backend/migrations/tenants/$SLUG.sql\` and run migrator.

## Manual review checklist
- [ ] Any \`auth.users\` FK references in \`0001_schema.sql\` — retarget to Pluto \`users\`.
- [ ] Custom \`SECURITY DEFINER\` functions — verify search_path.
- [ ] Extensions (uuid-ossp, pgcrypto) — confirm enabled on Pluto instance.
EOF

echo
echo "✔ Bundle ready: $OUT"
ls -la "$OUT"
echo
echo "Next: review $OUT/0001_schema.sql, then push via Dashboard → Auto Deploy → Migrations."
