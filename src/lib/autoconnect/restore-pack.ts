// Generates a one-click restore-and-rollback pack for the migration bundle.
export function buildApplyScript(opts: { db: string; sqlFile?: string }): string {
  const sql = opts.sqlFile ?? "001_pluto_auto.sql";
  return `#!/usr/bin/env bash
# Auto-Connect: apply migrations with automatic rollback on failure.
set -euo pipefail

DB_URL="\${DATABASE_URL:-${opts.db}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP_DIR="\${SNAP_DIR:-/var/backups/pluto-autoconnect}"
LOG_DIR="\${LOG_DIR:-/var/log/pluto-autoconnect}"
mkdir -p "$SNAP_DIR" "$LOG_DIR"
LOG="$LOG_DIR/apply-$STAMP.log"

echo "▶ Pre-migration snapshot → $SNAP_DIR/snap-$STAMP.dump" | tee -a "$LOG"
pg_dump "$DB_URL" -F c -Z 9 -f "$SNAP_DIR/snap-$STAMP.dump" 2>>"$LOG" || {
  echo "✘ snapshot failed — aborting" | tee -a "$LOG"; exit 2; }

echo "▶ Applying ${sql} in single transaction (ON_ERROR_STOP)…" | tee -a "$LOG"
if psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "${sql}" 2>>"$LOG"; then
  echo "✔ migrations applied successfully" | tee -a "$LOG"
  echo "$STAMP" > "$SNAP_DIR/last-good.txt"
  exit 0
fi

echo "✘ migration failed — automatic rollback" | tee -a "$LOG"
pg_restore -d "$DB_URL" --clean --if-exists --no-owner --no-privileges "$SNAP_DIR/snap-$STAMP.dump" 2>>"$LOG" || {
  echo "✘ rollback failed — manual intervention required" | tee -a "$LOG"; exit 3; }
echo "✔ rolled back to snap-$STAMP.dump" | tee -a "$LOG"
exit 1
`;
}

export function buildRollbackScript(): string {
  return `#!/usr/bin/env bash
# Manual rollback to latest snapshot.
set -euo pipefail
DB_URL="\${DATABASE_URL:?set DATABASE_URL}"
SNAP_DIR="\${SNAP_DIR:-/var/backups/pluto-autoconnect}"
LATEST=$(ls -1t "$SNAP_DIR"/snap-*.dump 2>/dev/null | head -1)
[ -n "$LATEST" ] || { echo "no snapshot found in $SNAP_DIR"; exit 1; }
echo "▶ restoring $LATEST"
pg_restore -d "$DB_URL" --clean --if-exists --no-owner --no-privileges "$LATEST"
echo "✔ rollback complete"
`;
}

export function buildRestoreReadme(): string {
  return `# Restore & Rollback Pack

## এক-ক্লিক Apply
\`\`\`bash
export DATABASE_URL="postgres://user:pass@host:5432/pluto"
bash apply.sh
\`\`\`
- ব্যর্থ হলে auto-rollback হবে।
- সফল snapshot \`/var/backups/pluto-autoconnect/snap-<ts>.dump\` এ থাকবে।

## Manual Rollback
\`\`\`bash
bash rollback.sh
\`\`\`

## Exit codes
| Code | মানে |
|---|---|
| 0 | সফল |
| 1 | মাইগ্রেশন ব্যর্থ, rollback সফল |
| 2 | snapshot ব্যর্থ |
| 3 | rollback ব্যর্থ — manual দরকার |
`;
}
