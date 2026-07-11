# Auto-Connect Studio — Phase 3 Enhancements

Five focused additions to `/auto-connect`, keeping the existing 6-step wizard intact.

---

## 1. Impact Summary + Explicit Acknowledgement (Dry-Run)

**Files**
- `src/lib/autoconnect/impact-analyzer.ts` (new)
- `src/components/autoconnect/ImpactSummary.tsx` (new)
- `src/components/autoconnect/DryRunPreview.tsx` (edit)

**What it computes** from the already-parsed `SqlStatement[]`:
- Tables created / altered / dropped (counts + names)
- Columns added / dropped / type-changed
- Indexes / constraints / FKs added or dropped
- RLS policies added/dropped, `GRANT` / `REVOKE` on which roles
- Estimated affected rows: `0` for `CREATE`, `unknown` for `ALTER/DROP` on existing tables — flagged red
- Destructive flags: `DROP`, `TRUNCATE`, `ALTER … DROP COLUMN`, `ALTER … TYPE` (data loss risk)

**UI**
- Panel above statement list: tiles for Tables / Columns / Policies / Grants / Destructive-ops.
- "I understand the impact" checkbox — **required** when destructive count > 0.
- Apply button disabled until (a) no destructive ops, or (b) checkbox ticked AND typed confirmation `APPLY`.

---

## 2. Snapshot Safety: Docker Volumes + Configs

**Files**
- `src/lib/autoconnect/restore-pack.ts` (edit — expand `apply.sh` / `rollback.sh`)
- `pluto-backend/deploy/backup/snapshot-volumes.sh` (new, referenced by generated pack)

**apply.sh additions** (runs before `psql`):
```
SNAP_DIR=/var/backups/pluto-autoconnect/<jobId>
# 1. pg_dump (already exists)
# 2. Docker volume snapshot
for v in $(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' pluto-pg pluto-api); do
  docker run --rm -v $v:/src -v $SNAP_DIR:/dst alpine \
    tar czf /dst/vol-$v.tgz -C /src .
done
# 3. Config snapshot
tar czf $SNAP_DIR/configs.tgz /etc/pluto /etc/pluto-autoconnect.env docker-compose.yml
sha256sum $SNAP_DIR/* > $SNAP_DIR/SHA256SUMS
```

**rollback.sh**: stop containers → `psql` restore from `pg_dump` → untar each `vol-*.tgz` back into the volume (`docker run --rm -v $v:/dst … tar xzf …`) → restore configs → start containers → health-check.

Manifest entry `snapshot.json` records volumes, config paths, checksums, timestamps so the rollback script can verify integrity before touching anything.

---

## 3. Rollback Log Viewer in `/auto-connect`

**Files**
- `src/lib/autoconnect/rollback-log.functions.ts` (new — `getRollbackLog(jobId)`, `listRollbackJobs()`)
- `src/components/autoconnect/RollbackLogViewer.tsx` (new)
- `src/routes/auto-connect.tsx` (edit — new tab "Rollback Logs")

**Log format** written by `apply.sh` to `/var/log/pluto-autoconnect/<jobId>.jsonl`:
```
{"ts":"...","step":"snapshot_db","status":"ok","durationMs":812}
{"ts":"...","step":"apply_sql","status":"fail","stmtIndex":7,"sql":"...","error":"..."}
{"ts":"...","step":"rollback","status":"ok"}
```

Server function tails the file via SSH-less local read (assumes VPS has the app running; for MVP the log ships back inside the downloaded ZIP under `logs/<jobId>.jsonl` and the viewer parses uploaded logs).

**Viewer UI**: timeline of steps, expandable failing step showing the offending SQL, error text, and a "Copy rollback command" button.

---

## 4. End-to-End Test Mode (Placeholder DB)

**Files**
- `src/lib/autoconnect/e2e-runner.functions.ts` (new)
- `src/components/autoconnect/E2ETestPanel.tsx` (new)
- `src/routes/auto-connect.tsx` (edit — "Test Mode" toggle in header)

**How it works**
- Server fn spins up an in-memory PGlite instance (`@electric-sql/pglite`) per session — no real DB touched.
- Runs the generated migration SQL against PGlite → captures output.
- Simulates failure at a chosen statement index (user picks from dropdown) to test rollback.
- Records per-step results (`dry-run`, `apply`, `induced-fail`, `rollback`) and shows pass/fail badges.

Add-package: `bun add @electric-sql/pglite` (WASM, Worker-safe).

---

## 5. ZIP Integrity Verification on Upload

**Files**
- `src/lib/autoconnect/zip-verify.ts` (new)
- `src/lib/autoconnect/analyzer.ts` (edit — call verifier first)
- `src/components/autoconnect/UploadStep.tsx` (edit — show verification panel)

**Flow**
1. On ZIP upload, look for `manifest.json` + `SHA256SUMS` at the root (produced by our backup pipeline / bundler).
2. If present: for every entry, recompute SHA-256 via `crypto.subtle.digest('SHA-256', bytes)` and compare.
3. Report table: file path, expected hash, actual hash, ✓/✗. Any mismatch blocks continuation.
4. If manifest is missing (user uploaded a raw project ZIP), show a warning banner and let them continue — verification just skipped, not failed.

Also emit `manifest.json` + `SHA256SUMS` in `bundler.ts` for every artifact we generate so downloaded packs are self-verifying.

---

## Stepper After Changes
```
Upload (+Verify) → Analyze → Structure Report → AI Plan
  → DB Wizard → Migrations (Dry-Run + Impact + Ack)
  → Wire APIs → Download (Restore Pack w/ Volume Snapshots)
[Header tabs] Test Mode · Rollback Logs
```

## Non-Goals
- No live SSH into the VPS from the browser — logs come via uploaded ZIP or a future agent.
- No editing of generated SQL in-browser (stays read-only with the ack flow).
