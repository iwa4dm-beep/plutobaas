
# Auto-Connect Studio — Phase 2 Enhancements

Auto-Connect Studio পেইজে (`/auto-connect`) ৫টি নতুন ফিচার যোগ করা হবে। বেশিরভাগ কাজ ক্লায়েন্ট-সাইড (JSZip in-memory) এবং কিছু হেল্পার ফাইল সার্ভার-সাইড।

---

## 1. এক-ক্লিক Restore-and-Rollback Pack

**কী হবে:** bundle-এর সাথে `restore-with-rollback.sh` স্ক্রিপ্ট generate হবে যা মাইগ্রেশন ব্যর্থ হলে auto-rollback করে।

**Flow:**
```text
apply.sh চালালে →
  1. Pre-migration snapshot (pg_dump -F c → snap-<ts>.dump)
  2. psql -v ON_ERROR_STOP=1 -1 -f migrations.sql  (single transaction)
  3. Success → snapshot retain; Failure → pg_restore auto rollback + exit 1
  4. Rollback log → /var/log/pluto-autoconnect/<jobId>.log
```

**নতুন ফাইল:**
- `src/lib/autoconnect/restore-pack.ts` — generates `apply.sh`, `rollback.sh`, `README-RESTORE.md`
- Bundle-এ auto-included via `bundler.ts`

---

## 2. Environment/Secret Auto-Map (Placeholder Restore)

**কী হবে:** Laravel `.env.example` স্ক্যান করে key list বের করবে → প্রতিটির জন্য Pluto BaaS equivalent map করবে → `pluto.env.template` তৈরি করবে যা systemd `EnvironmentFile=` compatible।

**Mapping table (built-in):**
| Laravel key | Pluto equivalent | Note |
|---|---|---|
| `DB_HOST/PORT/DATABASE/USERNAME/PASSWORD` | `PLUTO_PG_URL` | assembled |
| `APP_KEY` | `PLUTO_JWT_SECRET` | auto-generated placeholder `<GENERATE:32>` |
| `MAIL_*` | `PLUTO_SMTP_*` | 1:1 |
| `AWS_*` / `FILESYSTEM_DISK=s3` | `PLUTO_STORAGE_*` | S3-compatible |
| `SANCTUM_STATEFUL_DOMAINS` | `PLUTO_ALLOWED_ORIGINS` | CSV |
| unknown | passthrough with `# TODO` | flagged in report |

**Output artifacts:**
- `pluto.env.template` — plaintext template with `<GENERATE:N>` / `<REQUIRED>` placeholders
- `install-secrets.sh` — reads template, prompts missing, generates random ones, writes to `/etc/pluto-autoconnect.env` (mode 0600) and reloads target systemd unit

**নতুন ফাইল:** `src/lib/autoconnect/env-mapper.ts`

---

## 3. SQL Migration Dry-Run Preview (diff + impact)

**কী হবে:** apply-এর আগে UI-তে টেবিল-বাই-টেবিল প্রিভিউ:
- **Diff view** — proposed `CREATE TABLE` vs existing schema (যদি live Pluto DB connect করা থাকে, optional endpoint call; না হলে "assumed empty schema" mode)
- **Impact analysis** (heuristic, static):
  - New tables count
  - Destructive statements detected (`DROP`, `TRUNCATE`, `ALTER … DROP COLUMN`) — red badge
  - RLS enable per table
  - Estimated row cost (skipped — schema only)
  - FK cascade fanout
- **Row-level color coding:** green (create), yellow (alter), red (drop)

**নতুন ফাইল:**
- `src/lib/autoconnect/sql-analyzer.ts` — parse generated SQL → StatementNode[] with kind/table/destructive flag
- `src/components/autoconnect/DryRunPreview.tsx` — expandable per-statement view
- Step 4 (`MigrationsStep`)-এ integrate; "Apply" button disabled until user acknowledges destructive ops

---

## 4. DB Wizard (MySQL/PostgreSQL) + Connection String Validator

**কী হবে:** Step 3.5 হিসেবে নতুন উইজার্ড:
1. **Choose driver:** MySQL / PostgreSQL (radio)
2. **Connection string input** (or discrete fields: host/port/db/user/pass/ssl)
3. **Validate** — client sends to server function `validateDbConnection({driver, url})` → server does a lightweight TCP probe (using `pg`/`mysql2` if available; else regex + reachability via `net.connect` timeout 3s)
4. **Auto-generate driver config:**
   - PostgreSQL: `pluto.db.config.ts` uses `pg` Pool, migrations skip MySQL→PG converter
   - MySQL: enables `migration-converter.ts`-এর **MySQL→PG translation layer** (INT AUTO_INCREMENT → SERIAL, TINYINT(1) → BOOLEAN, ENGINE=InnoDB stripped, backticks → double-quotes, `DATETIME` → `TIMESTAMPTZ`)
5. Wizard result feeds Step 4 SQL generation

**নতুন ফাইল:**
- `src/lib/autoconnect/db-wizard.functions.ts` — server fn: `validateDbConnection`
- `src/lib/autoconnect/mysql-to-pg.ts` — SQL translator (reuse existing `pluto-backend/packages/api/tests/mysql-to-pg.test.ts` patterns)
- `src/components/autoconnect/DbWizardStep.tsx`

---

## 5. Detailed Structure Report Page

**কী হবে:** Step 2.5 হিসেবে (Analyze এর পরে) একটি expandable report:
- **Frontend tree:** package.json (framework, deps), vite.config.*, routes/pages, API call sites (file:line → endpoint) — used files highlighted green, unused গ্রে
- **Backend tree:** migrations (per-file table list), models (FK graph mini-diagram — text based), routes/api.php + web.php (method + path), controllers (used/unused), config/* files consumed
- **Usage highlighting rules:** referenced by imports / route registration = highlighted; orphan = gray with "unused" badge
- **Summary counts:** total files, used, unused, ignored (vendor/node_modules)
- **Download button:** `STRUCTURE_REPORT.md` (also auto-included in final bundle)

**নতুন ফাইল:**
- `src/lib/autoconnect/structure-report.ts` — build tree + usage graph
- `src/components/autoconnect/StructureReport.tsx` — collapsible tree UI

`analyzer.ts` এ minor extension: track `filesUsed: Set<string>`, `filesUnused: string[]`.

---

## File Change Summary

**New (10):**
- `src/lib/autoconnect/restore-pack.ts`
- `src/lib/autoconnect/env-mapper.ts`
- `src/lib/autoconnect/sql-analyzer.ts`
- `src/lib/autoconnect/db-wizard.functions.ts`
- `src/lib/autoconnect/mysql-to-pg.ts`
- `src/lib/autoconnect/structure-report.ts`
- `src/components/autoconnect/DryRunPreview.tsx`
- `src/components/autoconnect/DbWizardStep.tsx`
- `src/components/autoconnect/StructureReport.tsx`
- `src/components/autoconnect/RestorePackPreview.tsx`

**Modified (4):**
- `src/routes/auto-connect.tsx` — steps 2.5, 3.5 যোগ, wiring
- `src/lib/autoconnect/analyzer.ts` — usage graph tracking
- `src/lib/autoconnect/bundler.ts` — restore-pack + env template inject
- `src/lib/autoconnect/types.ts` — new types (DbConfig, StructureReport, SqlStatement)

## Stepper (new)

```text
1 Upload → 2 Analyze → 2.5 Structure Report → 3 AI Plan
  → 3.5 DB Wizard → 4 Migrations (+Dry-Run) → 5 Wire APIs → 6 Download (+Restore Pack)
```

সব ক্লায়েন্ট-সাইড, কেবল `validateDbConnection` সার্ভার fn। Lovable Cloud/AI already enabled।

Approve করলে ধাপে ধাপে সব ফাইল তৈরি করব।
