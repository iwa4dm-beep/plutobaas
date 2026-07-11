// Generates a one-click restore-and-rollback pack for the migration bundle.
// Now snapshots BOTH the DB and Docker volumes + configs so rollback truly
// returns to the previous state.

export function buildApplyScript(opts: { db: string; sqlFile?: string; volumes?: string[]; configs?: string[]; retentionDays?: number; snapshotRoot?: string }): string {
  const sql = opts.sqlFile ?? "001_pluto_auto.sql";
  const volumes = (opts.volumes ?? ["pluto_pgdata", "pluto_api_data"]).join(" ");
  const configs = (opts.configs ?? ["/etc/pluto", "/etc/pluto-autoconnect.env"]).join(" ");
  const retention = opts.retentionDays ?? 14;
  const snapRoot = opts.snapshotRoot ?? "/var/backups/pluto-autoconnect";
  return `#!/usr/bin/env bash
# Auto-Connect: apply migrations with FULL snapshot (DB + Docker volumes + configs)
# and automatic rollback on failure. Every step is journaled to a JSONL log
# so the /auto-connect Rollback Log Viewer can replay what happened.
set -euo pipefail

BUNDLE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DB_URL="\${DATABASE_URL:-${opts.db}}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
JOB_ID="\${JOB_ID:-job-$STAMP}"
SNAP_ROOT="\${SNAP_ROOT:-${snapRoot}}"
SNAP_DIR="$SNAP_ROOT/$JOB_ID"
LOG_DIR="\${LOG_DIR:-$SNAP_ROOT/logs}"
mkdir -p "$SNAP_DIR" "$LOG_DIR"
LOG_TXT="$LOG_DIR/$JOB_ID.log"
LOG_JSON="$LOG_DIR/$JOB_ID.jsonl"
CANCEL_FLAG="$LOG_DIR/$JOB_ID.cancel"
VOLUMES="\${PLUTO_VOLUMES:-${volumes}}"
CONFIGS="\${PLUTO_CONFIGS:-${configs}}"
RETENTION_DAYS="\${RETENTION_DAYS:-${retention}}"

check_cancel() {
  if [ -f "$CANCEL_FLAG" ]; then
    jlog "cancel" "start" "\\"reason\\":\\"cancel flag detected at $CANCEL_FLAG\\""
    echo "▶ CANCEL requested — rolling back" | tee -a "$LOG_TXT"
    do_rollback || true
    jlog "cancel" "done"
    rm -f "$CANCEL_FLAG"
    trap - EXIT
    exit 4
  fi
}

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
if psql "$DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$BUNDLE_DIR/${sql}" 2>>"$LOG_TXT"; then
  jlog "apply_sql" "ok"
  echo "$JOB_ID" > "$SNAP_ROOT/last-good.txt"

  # 7) Retention cleanup — remove snapshots & logs older than RETENTION_DAYS
  jlog "retention" "start" "\\"days\\":$RETENTION_DAYS"
  REMOVED_SNAPS=$(find "$SNAP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +$RETENTION_DAYS 2>/dev/null | wc -l | tr -d ' ')
  find "$SNAP_ROOT" -maxdepth 1 -mindepth 1 -type d -mtime +$RETENTION_DAYS -exec rm -rf {} + 2>>"$LOG_TXT" || true
  REMOVED_LOGS=$(find "$LOG_DIR" -maxdepth 1 -type f \\( -name '*.log' -o -name '*.jsonl' \\) -mtime +$RETENTION_DAYS 2>/dev/null | wc -l | tr -d ' ')
  find "$LOG_DIR" -maxdepth 1 -type f \\( -name '*.log' -o -name '*.jsonl' \\) -mtime +$RETENTION_DAYS -delete 2>>"$LOG_TXT" || true
  jlog "retention" "ok" "\\"snapshotsRemoved\\":$REMOVED_SNAPS,\\"logsRemoved\\":$REMOVED_LOGS"

  jlog "done" "ok"
  echo "✔ migrations applied successfully (retention: -$RETENTION_DAYS d, cleaned $REMOVED_SNAPS snap / $REMOVED_LOGS log)" | tee -a "$LOG_TXT"
  trap - EXIT
  exit 0
fi

# 8) Failure → rollback
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
# Verifies both the bundle SHA256SUMS (this pack) and the snapshot SHA256SUMS
# before touching anything, with a clear failure reason if either check fails.
set -euo pipefail
BUNDLE_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DB_URL="\${DATABASE_URL:?set DATABASE_URL}"
SNAP_ROOT="\${SNAP_ROOT:-/var/backups/pluto-autoconnect}"
JOB_ID="\${1:-$(ls -1t "$SNAP_ROOT" 2>/dev/null | head -1)}"
SNAP="$SNAP_ROOT/$JOB_ID"

die() { echo "✘ $1"; exit "\${2:-2}"; }

[ -d "$SNAP" ] || die "snapshot not found: $SNAP" 1

echo "▶ Verifying restore-pack integrity…"
[ -f "$BUNDLE_DIR/SHA256SUMS" ] || die "bundle SHA256SUMS missing — restore-pack untrusted"
( cd "$BUNDLE_DIR" && sha256sum -c --strict --quiet SHA256SUMS ) \\
  || die "restore-pack checksum mismatch — refuse to run (bundle corrupt/tampered)"

echo "▶ Verifying snapshot checksums for $JOB_ID…"
[ -f "$SNAP/SHA256SUMS" ] || die "snapshot SHA256SUMS missing at $SNAP — refuse rollback"
( cd "$SNAP" && sha256sum -c --strict --quiet SHA256SUMS ) \\
  || die "snapshot checksum mismatch — $JOB_ID is corrupt, pick another jobId"

echo "▶ Restoring DB…"
pg_restore -d "$DB_URL" --clean --if-exists --no-owner --no-privileges "$SNAP/db.dump" \\
  || die "pg_restore failed — DB not modified"

if command -v docker >/dev/null 2>&1 && [ -f "$SNAP/snapshot.json" ]; then
  for f in "$SNAP"/vol-*.tgz; do
    [ -f "$f" ] || continue
    v="$(basename "$f" .tgz | sed 's/^vol-//')"
    echo "▶ Restoring volume $v…"
    docker run --rm -v "$v":/dst -v "$SNAP":/src alpine \\
      sh -c "rm -rf /dst/* /dst/.[!.]* 2>/dev/null; tar xzf /src/vol-$v.tgz -C /dst" \\
      || die "volume restore failed: $v"
  done
fi

[ -f "$SNAP/configs.tgz" ] && { echo "▶ Restoring configs…"; tar xzf "$SNAP/configs.tgz" -C / || die "config restore failed"; }
echo "✔ rollback complete for $JOB_ID"
`;
}

// Server-Sent-Events tailer served by the VPS so the /auto-connect page
// can stream real-time apply/rollback progress via EventSource.
export function buildServeProgressScript(): string {
  return `#!/usr/bin/env bash
# Serve the running JOB's JSONL log over HTTP/SSE for the /auto-connect page.
# Usage:  JOB_ID=job-... bash serve-progress.sh [PORT]   # default port 8787
#         (bind 127.0.0.1 by default — expose over SSH tunnel: ssh -L 8787:127.0.0.1:8787 …)
set -euo pipefail
LOG_DIR="\${LOG_DIR:-/var/log/pluto-autoconnect}"
JOB_ID="\${JOB_ID:-$(ls -1t "$LOG_DIR"/*.jsonl 2>/dev/null | head -1 | xargs -n1 basename | sed 's/\\.jsonl$//')}"
PORT="\${1:-8787}"
BIND="\${BIND:-127.0.0.1}"
LOG_JSON="$LOG_DIR/$JOB_ID.jsonl"
[ -f "$LOG_JSON" ] || { echo "no log for $JOB_ID at $LOG_JSON"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required"; exit 1; }

echo "▶ SSE progress for $JOB_ID on http://$BIND:$PORT/stream"
LOG_JSON="$LOG_JSON" PORT="$PORT" BIND="$BIND" python3 - <<'PY'
import os, time, http.server, threading
LOG=os.environ['LOG_JSON']; PORT=int(os.environ['PORT']); BIND=os.environ['BIND']
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path not in ('/stream','/'):
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Type','text/event-stream')
        self.send_header('Cache-Control','no-cache')
        self.send_header('Access-Control-Allow-Origin','*')
        self.end_headers()
        try:
            with open(LOG,'r') as f:
                # send existing history first
                for line in f:
                    if line.strip():
                        self.wfile.write(f"data: {line.strip()}\\n\\n".encode()); self.wfile.flush()
                while True:
                    line=f.readline()
                    if not line:
                        self.wfile.write(b": ping\\n\\n"); self.wfile.flush()
                        time.sleep(1); continue
                    self.wfile.write(f"data: {line.strip()}\\n\\n".encode()); self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError): pass
http.server.ThreadingHTTPServer((BIND,PORT), H).serve_forever()
PY
`;
}

export function buildRestoreReadme(): string {
  return `# Restore & Rollback Pack

## এক-ক্লিক Apply (verified bundle + DB/volume/config snapshot)
\`\`\`bash
export DATABASE_URL="postgres://user:pass@host:5432/pluto"
export RETENTION_DAYS=14           # optional, default 14 — auto-cleans older snapshots + logs
bash apply.sh
\`\`\`
- Pre-flight: \`sha256sum -c SHA256SUMS\` on the bundle itself — mismatch aborts with a clear reason **before** anything is touched.
- Snapshot: \`/var/backups/pluto-autoconnect/<jobId>/\` — \`db.dump\`, \`vol-*.tgz\`, \`configs.tgz\`, \`SHA256SUMS\`, \`snapshot.json\`.
- ব্যর্থ হলে auto-rollback: DB → volumes → configs।
- সফল হলে \`$SNAP_ROOT\` ও \`$LOG_DIR\`-এ \`RETENTION_DAYS\`-এর চেয়ে পুরনো ফাইল স্বয়ংক্রিয়ভাবে delete হবে।
- Structured log: \`/var/log/pluto-autoconnect/<jobId>.jsonl\`।

## Real-time progress → /auto-connect
\`\`\`bash
JOB_ID=job-20260711T… bash serve-progress.sh 8787
# local dev machine:
ssh -L 8787:127.0.0.1:8787 you@vps
# then in the "Rollback Logs" tab, paste: http://127.0.0.1:8787/stream
\`\`\`

## Manual Rollback (bundle + snapshot both checksum-verified)
\`\`\`bash
bash rollback.sh                 # latest snapshot
bash rollback.sh job-20260711T…  # specific job
\`\`\`

## Exit codes
| Code | মানে |
|---|---|
| 0 | সফল |
| 1 | মাইগ্রেশন ব্যর্থ, auto-rollback সম্পন্ন |
| 2 | verify / snapshot ব্যর্থ (কারণ stderr-এ) |
| 3 | rollback ব্যর্থ — manual দরকার |
`;
}
