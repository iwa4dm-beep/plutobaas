#!/usr/bin/env bash
# migrate-frontend-to-pluto.sh
# ---------------------------------------------------------------
# Rewrites a Vite/React project's Supabase client usage to Pluto BaaS.
#
# Usage (from inside the project root, e.g. /opt/timesn):
#   bash /opt/pluto/deploy/migrate-frontend-to-pluto.sh          # apply
#   bash /opt/pluto/deploy/migrate-frontend-to-pluto.sh --dry    # preview only
#
# What it does:
#   1. Scans src/ for Supabase imports and env references
#   2. package.json:   @supabase/supabase-js  →  @timescard/pluto-js
#   3. All *.ts/.tsx/.js/.jsx:
#        import { createClient } from "@supabase/supabase-js"
#          → import { createClient } from "@timescard/pluto-js"
#        import ... from "@/integrations/supabase/client"
#          → import ... from "@/lib/pluto"
#        VITE_SUPABASE_URL       → VITE_PLUTO_URL
#        VITE_SUPABASE_ANON_KEY  → VITE_PLUTO_ANON_KEY
#   4. Writes a compat shim at src/lib/pluto.ts that re-exports the client
#      as both `pluto` and `supabase` so existing call sites keep compiling.
#   5. Updates .env / .env.example
#   6. Leaves a backup copy of every changed file at <file>.bak-supabase
# ---------------------------------------------------------------
set -euo pipefail

DRY=0
if [[ "${1:-}" == "--dry" || "${1:-}" == "-n" ]]; then
  DRY=1
fi

ROOT="$(pwd)"
if [[ ! -f "$ROOT/package.json" ]]; then
  echo "✗ package.json not found in $ROOT — run this from the project root." >&2
  exit 2
fi

log()  { printf "\033[1;36m[migrate]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[warn]   \033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ok]     \033[0m %s\n" "$*"; }
die()  { printf "\033[1;31m[fail]   \033[0m %s\n" "$*" >&2; exit 1; }

if [[ $DRY -eq 1 ]]; then log "DRY-RUN mode — no files will be written."; fi

# ---------------------------------------------------------------
# 1. Scan (imports, env vars, hardcoded supabase.co URLs, literal JWT anon keys)
# ---------------------------------------------------------------
log "Scanning for Supabase references…"
SCAN_RE='(@supabase/supabase-js|@/integrations/supabase|VITE_SUPABASE_|https?://[a-z0-9-]+\.supabase\.(co|in)|eyJhbGciOiJIUzI1NiIs)'
mapfile -t FILES < <(
  find "$ROOT/src" "$ROOT/app" -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) 2>/dev/null \
    | xargs -r grep -l -E "$SCAN_RE" 2>/dev/null || true
)

if [[ ${#FILES[@]} -eq 0 ]]; then
  warn "No Supabase references found in src/. Nothing to rewrite."
else
  log "Found ${#FILES[@]} file(s) with Supabase references:"
  printf '   %s\n' "${FILES[@]}"
fi

# ---------------------------------------------------------------
# 2. package.json
# ---------------------------------------------------------------
if grep -q '"@supabase/supabase-js"' "$ROOT/package.json"; then
  log "package.json: @supabase/supabase-js → @timescard/pluto-js"
  if [[ $DRY -eq 0 ]]; then
    cp -n "$ROOT/package.json" "$ROOT/package.json.bak-supabase" || true
    sed -i 's#"@supabase/supabase-js"#"@timescard/pluto-js"#g' "$ROOT/package.json"
  fi
fi

# ---------------------------------------------------------------
# 3. Rewrite source files — imports, env names, AND hardcoded literals
# ---------------------------------------------------------------
# Placeholders that resolve to Pluto env vars at runtime (safe fallback shape).
PLUTO_URL_LITERAL='(import.meta.env.VITE_PLUTO_URL as string)'
PLUTO_KEY_LITERAL='(import.meta.env.VITE_PLUTO_ANON_KEY as string)'

rewrite_file() {
  local f="$1"
  if [[ $DRY -eq 0 ]]; then
    cp -n "$f" "$f.bak-supabase"
  fi
  # 3a. Import paths + env-var names
  sed -E -i \
    -e 's#@supabase/supabase-js#@timescard/pluto-js#g' \
    -e 's#@/integrations/supabase/client#@/lib/pluto#g' \
    -e 's#@/integrations/supabase/types#@/lib/pluto#g' \
    -e 's#VITE_SUPABASE_URL#VITE_PLUTO_URL#g' \
    -e 's#VITE_SUPABASE_ANON_KEY#VITE_PLUTO_ANON_KEY#g' \
    -e 's#VITE_SUPABASE_PUBLISHABLE_KEY#VITE_PLUTO_ANON_KEY#g' \
    "$f"
  # 3b. Hardcoded supabase.co URL literals -> Pluto env expression
  #     Matches "https://xxx.supabase.co" or 'https://xxx.supabase.co' (with optional trailing path)
  perl -0777 -i -pe '
    s#"https?://[a-z0-9-]+\.supabase\.(?:co|in)[^"]*"#'"$PLUTO_URL_LITERAL"'#g;
    s#'"'"'https?://[a-z0-9-]+\.supabase\.(?:co|in)[^'"'"']*'"'"'#'"$PLUTO_URL_LITERAL"'#g;
  ' "$f"
  # 3c. Hardcoded Supabase anon JWT (starts with eyJhbGciOiJIUzI1NiIs) -> Pluto env expression
  perl -0777 -i -pe '
    s#"eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_.\-]+"#'"$PLUTO_KEY_LITERAL"'#g;
    s#'"'"'eyJhbGciOiJIUzI1NiIs[A-Za-z0-9_.\-]+'"'"'#'"$PLUTO_KEY_LITERAL"'#g;
  ' "$f"
}

for f in "${FILES[@]:-}"; do
  [[ -z "$f" ]] && continue
  if [[ $DRY -eq 1 ]]; then
    echo "--- would rewrite: $f ---"
  else
    rewrite_file "$f"
  fi
done

# ---------------------------------------------------------------
# 3d. Replace the whole legacy client file with a Pluto re-export shim
# ---------------------------------------------------------------
LEGACY_DIR="$ROOT/src/integrations/supabase"
if [[ -d "$LEGACY_DIR" && $DRY -eq 0 ]]; then
  log "Neutralising legacy client at src/integrations/supabase/client.*"
  for legacy in "$LEGACY_DIR"/client.ts "$LEGACY_DIR"/client.tsx "$LEGACY_DIR"/client.js; do
    [[ -f "$legacy" ]] || continue
    cp -n "$legacy" "$legacy.bak-supabase"
    cat > "$legacy" <<'LEGACY'
// Neutralised by migrate-frontend-to-pluto.sh — now re-exports the Pluto client.
export { pluto, supabase, supabase as default } from "@/lib/pluto";
LEGACY
  done
fi

# ---------------------------------------------------------------
# 4. Compat shim: src/lib/pluto.ts (exports both `pluto` and `supabase`)
# ---------------------------------------------------------------
SHIM="$ROOT/src/lib/pluto.ts"
if [[ $DRY -eq 0 ]]; then
  mkdir -p "$ROOT/src/lib"
  cat > "$SHIM" <<'EOF'
// Auto-generated by migrate-frontend-to-pluto.sh
// Central Pluto BaaS client. Exports both `pluto` and `supabase`
// so existing `import { supabase } from ...` call sites keep working.
import { createClient } from "@timescard/pluto-js";

const url     = import.meta.env.VITE_PLUTO_URL as string;
const anonKey = import.meta.env.VITE_PLUTO_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_PLUTO_URL / VITE_PLUTO_ANON_KEY — set them in .env",
  );
}

export const pluto = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "pluto.auth.token",
  },
});

// Backwards-compat alias so imports like
//   import { supabase } from "@/lib/pluto"
// (rewritten from "@/integrations/supabase/client") continue to type-check.
export const supabase = pluto;
export default pluto;
EOF
  ok "Wrote compat shim: src/lib/pluto.ts"
else
  log "(dry) would write src/lib/pluto.ts compat shim"
fi

# ---------------------------------------------------------------
# 5. .env / .env.example
# ---------------------------------------------------------------
update_env() {
  local f="$1"
  [[ -f "$f" ]] || return 0
  if grep -qE '^VITE_SUPABASE_' "$f"; then
    log ".env: renaming VITE_SUPABASE_* → VITE_PLUTO_*  ($f)"
    if [[ $DRY -eq 0 ]]; then
      cp -n "$f" "$f.bak-supabase"
      sed -E -i \
        -e 's#^VITE_SUPABASE_URL=.*#VITE_PLUTO_URL=https://api.timescard.cloud#' \
        -e 's#^VITE_SUPABASE_ANON_KEY=.*#VITE_PLUTO_ANON_KEY=pk_anon_REPLACE_ME#' \
        -e 's#^VITE_SUPABASE_PUBLISHABLE_KEY=.*#VITE_PLUTO_ANON_KEY=pk_anon_REPLACE_ME#' \
        "$f"
    fi
  fi
}
update_env "$ROOT/.env"
update_env "$ROOT/.env.local"
update_env "$ROOT/.env.example"

if [[ ! -f "$ROOT/.env" && $DRY -eq 0 ]]; then
  cat > "$ROOT/.env" <<'EOF'
VITE_PLUTO_URL=https://api.timescard.cloud
VITE_PLUTO_ANON_KEY=pk_anon_REPLACE_ME
EOF
  ok "Created .env template — edit VITE_PLUTO_ANON_KEY before rebuilding."
fi

# ---------------------------------------------------------------
# 6. Summary
# ---------------------------------------------------------------
echo
ok "Rewrite pass complete."
echo "Next steps:"
echo "  1. Edit .env → set VITE_PLUTO_ANON_KEY (from Pluto Dashboard → Workspace → API Keys)."
echo "  2. bun remove @supabase/supabase-js  &&  bun add @timescard/pluto-js"
echo "  3. bun run build"
echo "  4. Verify: grep -r 'supabase.co' dist/ || echo '✔ no supabase.co left in bundle'"
echo "  5. Deploy: zip -r /tmp/<slug>.zip dist/* && curl … /unpack"
echo "  6. bash /opt/pluto/deploy/verify-pluto-cutover.sh <your-domain>"
