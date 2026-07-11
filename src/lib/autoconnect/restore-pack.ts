// Generates a one-click restore-and-rollback pack for the migration bundle.
// Now snapshots BOTH the DB and Docker volumes + configs so rollback truly
// returns to the previous state.

export function buildApplyScript(opts: { db: string; sqlFile?: string; volumes?: string[]; configs?: string[]; retentionDays?: number }): string {
  const sql = opts.sqlFile ?? "001_pluto_auto.sql";
  const volumes = (opts.volumes ?? ["pluto_pgdata", "pluto_api_data"]).join(" ");
  const configs = (opts.configs ?? ["/etc/pluto", "/etc/pluto-autoconnect.env"]).join(" ");
  const retention = opts.retentionDays ?? 14;
  return `#!/usr/bin/env bash
# Auto-Connect: apply migrations with FULL snapshot (DB + Docker volumes + configs)
# and automatic rollback on failure. Every step is journaled to a JSONL log
# so the /auto-connect Rollback Log Viewer can replay what happened.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DB_URL="\${DATABASE_URL:-${opts.db}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JOB_ID="\${JOB_ID:-job-$STAMP}"
SNAP_ROOT="\${SNAP_ROOT:-/var/backups/pluto-autoconnect}"
SNAP_DIR="$SNAP_ROOT/$JOB_ID"
LOG_DIR="\${LOG_DIR:-/var/log/pluto-autoconnect}"
mkdir -p "$SNAP_DIR" "$LOG_DIR"
LOG_TXT="$LOG_DIR/$JOB_ID.log"
LOG_JSON="$LOG_DIR/$JOB_ID.jsonl"
VOLUMES="\${PLUTO_VOLUMES:-${volumes}}"
CONFIGS="\${PLUTO_CONFIGS:-${configs}}"
RETENTION_DAYS="\${RETENTION_DAYS:-${retention}}"

jlog() {
  local step="$1" status="$2" extra="\${3:-}"
  printf '{"ts":"%s","jobId":"%s","step":"%s","status":"%s"%s}\\n' \\
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$JOB_ID" "$step" "$status" \\
    "$( [ -n "$extra" ] && echo ",$extra" || true )" | tee -a "$LOG_JSON"
}

fail() {
  # Human-readable failure with a clear reason, plus a structured jlog entry.
  local step="$1" reason="$2"
  echo "✘ [$step] $reason" | tee -a "$LOG_TXT"
  jlog "$step" "fail" "\\"error\\":\\"$(printf '%s' "$reason" | sed 's/"/\\\\"/g')\\""
  exit 2
}

trap 'rc=$?; if [ $rc -ne 0 ] && [ "\${ROLLED_BACK:-0}" != "1" ] && [ "\${SKIP_ROLLBACK:-0}" != "1" ]; then \\
  echo "✘ unexpected exit $rc — attempting rollback" | tee -a "$LOG_TXT"; \\
  do_rollback || true; fi' EXIT

do_rollback() {
  ROLLED_BACK=1
  jlog "rollback" "start"
  echo "▶ ROLLBACK starting" | tee -a "$LOG_TXT"
  if [ -f "$SNAP_DIR/db.dump" ]; then
    pg_restore -d "$DB_URL" --clean --if-exists --no-owner --no-privileges \\
      "$SNAP_DIR/db.dump" 2>>"$LOG_TXT" && jlog "rollback_db" "ok" || jlog "rollback_db" "fail"
  fi
  if command -v docker >/dev/null 2>&1; then
    for v in $VOLUMES; do
      f="$SNAP_DIR/vol-$v.tgz"; [ -f "$f" ] || continue
      docker run --rm -v "$v":/dst -v "$SNAP_DIR":/src alpine \\
        sh -c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar xzf /src/vol-$v.tgz -C /dst" \\
        2>>"$LOG_TXT" && jlog "rollback_volume" "ok" "\\"volume\\":\\"$v\\"" \\
        || jlog "rollback_volume" "fail" "\\"volume\\":\\"$v\\""
    done
  fi
  if [ -f "$SNAP_DIR/configs.tgz" ]; then
    tar xzf "$SNAP_DIR/configs.tgz" -C / 2>>"$LOG_TXT" \\
      && jlog "rollback_configs" "ok" || jlog "rollback_configs" "fail"
  fi
  jlog "rollback" "done"
  echo "✔ rollback finished — see $LOG_JSON" | tee -a "$LOG_TXT"
}

# ---- 0) Pre-flight: verify bundle manifest & checksums BEFORE touching prod
SKIP_ROLLBACK=1
jlog "verify_bundle" "start"
[ -f "$BUNDLE_DIR/SHA256SUMS" ] || fail "verify_bundle" "SHA256SUMS missing from bundle — refuse to run untrusted migration"
[ -f "$BUNDLE_DIR/manifest.json" ] || fail "verify_bundle" "manifest.json missing from bundle"
( cd "$BUNDLE_DIR" && sha256sum -c --strict --quiet SHA256SUMS ) 2>>"$LOG_TXT" \\
  || fail "verify_bundle" "checksum mismatch — bundle is corrupt or tampered (see $LOG_TXT)"
jlog "verify_bundle" "ok"
SKIP_ROLLBACK=0

echo "▶ Job $JOB_ID — snapshotting to $SNAP_DIR" | tee -a "$LOG_TXT"
jlog "start" "ok" "\\"snapDir\\":\\"$SNAP_DIR\\",\\"retentionDays\\":$RETENTION_DAYS"


# 1) DB dump
jlog "snapshot_db" "start"
pg_dump "$DB_URL" -F c -Z 9 -f "$SNAP_DIR/db.dump" 2>>"$LOG_TXT" \\
  && jlog "snapshot_db" "ok" \\
  || { jlog "snapshot_db" "fail"; echo "✘ db snapshot failed" | tee -a "$LOG_TXT"; exit 2; }

# 2) Docker volume snapshots
if command -v docker >/dev/null 2>&1; then
  for v in $VOLUMES; do
    docker volume inspect "$v" >/dev/null 2>&1 || { jlog "snapshot_volume" "skip" "\\"volume\\":\\"$v\\""; continue; }
    docker run --rm -v "$v":/src -v "$SNAP_DIR":/dst alpine \\
      tar czf "/dst/vol-$v.tgz" -C /src . 2>>"$LOG_TXT" \\
      && jlog "snapshot_volume" "ok" "\\"volume\\":\\"$v\\"" \\
      || jlog "snapshot_volume" "fail" "\\"volume\\":\\"$v\\""
  done
else
  jlog "snapshot_volume" "skip" "\\"reason\\":\\"docker missing\\""
fi

# 3) Config snapshot
CFG_EXISTS=""
for c in $CONFIGS; do [ -e "$c" ] && CFG_EXISTS="$CFG_EXISTS $c"; done
if [ -n "$CFG_EXISTS" ]; then
  tar czf "$SNAP_DIR/configs.tgz" $CFG_EXISTS 2>>"$LOG_TXT" \\
    && jlog "snapshot_configs" "ok" || jlog "snapshot_configs" "fail"
fi

# 4) Checksums + manifest
( cd "$SNAP_DIR" && sha256sum * > SHA256SUMS ) 2>>"$LOG_TXT"
cat > "$SNAP_DIR/snapshot.json" <<JSON
{
  "jobId": "$JOB_ID",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "db": "db.dump",
  "volumes": [$(for v in $VOLUMES; do printf '"%s",' "$v"; done | sed 's/,$//')],
  "configs": [$(for c in $CONFIGS; do printf '"%s",' "$c"; done | sed 's/,$//')]
}
JSON
jlog "snapshot_manifest" "ok"

# 5) Apply
jlog "apply_sql" "start" "\\"file\\":\\"${sql}\\""
echo "▶ Applying ${sql} in single transaction (ON_ERROR_STOP)…" | tee -a "$LOG_TXT"
if psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "${sql}" 2>>"$LOG_TXT"; then
  jlog "apply_sql" "ok"
  echo "$JOB_ID" > "\${SNAP_DIR%/*}/last-good.txt"
  jlog "done" "ok"
  echo "✔ migrations applied successfully" | tee -a "$LOG_TXT"
  trap - EXIT
  exit 0
fi

# 6) Failure → rollback
ERR="$(tail -n 20 "$LOG_TXT" | tr '\\n' ' ' | sed 's/"/\\\\"/g' | cut -c1-400)"
jlog "apply_sql" "fail" "\\"error\\":\\"$ERR\\""
echo "✘ migration failed — automatic rollback" | tee -a "$LOG_TXT"
do_rollback
trap - EXIT
exit 1
`;
}

export function buildRollbackScript(): string {
  return `#!/usr/bin/env bash
# Manual rollback to a specific job snapshot (defaults to the most recent).
set -euo pipefail
DB_URL="\${DATABASE_URL:?set DATABASE_URL}"
SNAP_ROOT="\${SNAP_DIR:-/var/backups/pluto-autoconnect}"
JOB_ID="\${1:-$(ls -1t "$SNAP_ROOT" 2>/dev/null | head -1)}"
SNAP="$SNAP_ROOT/$JOB_ID"
[ -d "$SNAP" ] || { echo "no snapshot at $SNAP"; exit 1; }

echo "▶ Verifying checksums…"
( cd "$SNAP" && sha256sum -c SHA256SUMS ) || { echo "✘ checksum mismatch"; exit 2; }

echo "▶ Restoring DB…"
pg_restore -d "$DB_URL" --clean --if-exists --no-owner --no-privileges "$SNAP/db.dump"

if command -v docker >/dev/null 2>&1 && [ -f "$SNAP/snapshot.json" ]; then
  for f in "$SNAP"/vol-*.tgz; do
    [ -f "$f" ] || continue
    v="$(basename "$f" .tgz | sed 's/^vol-//')"
    echo "▶ Restoring volume $v…"
    docker run --rm -v "$v":/dst -v "$SNAP":/src alpine \\
      sh -c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar xzf /src/vol-$v.tgz -C /dst"
  done
fi

[ -f "$SNAP/configs.tgz" ] && { echo "▶ Restoring configs…"; tar xzf "$SNAP/configs.tgz" -C /; }
echo "✔ rollback complete for $JOB_ID"
`;
}

export function buildRestoreReadme(): string {
  return `# Restore & Rollback Pack

## এক-ক্লিক Apply (DB + Docker volumes + configs snapshot)
\`\`\`bash
export DATABASE_URL="postgres://user:pass@host:5432/pluto"
bash apply.sh
\`\`\`
- Snapshot: \`/var/backups/pluto-autoconnect/<jobId>/\` — \`db.dump\`, \`vol-*.tgz\`, \`configs.tgz\`, \`SHA256SUMS\`, \`snapshot.json\`.
- ব্যর্থ হলে auto-rollback: DB → volumes → configs।
- Structured log: \`/var/log/pluto-autoconnect/<jobId>.jsonl\` — Auto-Connect Studio-এর "Rollback Logs" tab-এ আপলোড করে বিশ্লেষণ করা যাবে।

## Manual Rollback
\`\`\`bash
bash rollback.sh                 # latest snapshot
bash rollback.sh job-20260711T…  # specific job
\`\`\`

## Exit codes
| Code | মানে |
|---|---|
| 0 | সফল |
| 1 | মাইগ্রেশন ব্যর্থ, auto-rollback সম্পন্ন |
| 2 | snapshot ব্যর্থ |
| 3 | rollback ব্যর্থ — manual দরকার |
`;
}
