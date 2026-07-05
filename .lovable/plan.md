# Phase 9 — Governance, Safety, and Schema Evolution

Five focused additions to Pluto BaaS. All backend endpoints go under existing `/admin/v1/*`; all UI is new tabs/pages in the Pluto Admin console.

---

## 1. Audit log for CRUD / import / export / SQL

**Backend (`0006_governance.sql`):**
- `admin.audit_log(id, actor_id, project_id, action, resource_type, resource_id, params jsonb, result text, duration_ms int, created_at)`
- Trigger helper `admin.log_event(action, resource_type, resource_id, params, result, ms)`
- Wrap existing SQL runner, REST insert/update/delete, storage upload/delete, CSV import/export, migration apply — each writes one row.

**API:**
- `GET /admin/v1/audit?project_id=&limit=&action=&since=` — paged list (superadmin sees all; project members see own).
- `GET /admin/v1/audit/:id` — full record with params blob.

**UI (`dashboard.pluto-audit.tsx`):**
- Timestamp, actor, action badge, resource, duration, expandable JSON params.
- Filters (project, action, date-range), tail/refresh, CSV export.
- Client-side "UI history" ring buffer (last 100 admin actions this session) shown in a right-side drawer for immediate feedback before server round-trip.

---

## 2. Indexes and constraints UI + backend

**Backend `/admin/v1/schema/*`:**
- `GET /admin/v1/schema/tables/:schema/:table/indexes` — list from `pg_indexes`.
- `POST /admin/v1/schema/indexes` — `{ schema, table, name, columns[], method: btree|gin|gist|hash, unique?, where? }` → `CREATE INDEX [UNIQUE] ... USING method ...`.
- `DELETE /admin/v1/schema/indexes/:name` — `DROP INDEX`.
- `GET /admin/v1/schema/tables/:schema/:table/constraints` — from `pg_constraint`.
- `POST /admin/v1/schema/constraints` — types: `unique`, `check`, `not_null`, `foreign_key`. Each generates the correct `ALTER TABLE … ADD CONSTRAINT` / `ALTER COLUMN … SET NOT NULL`.
- `DELETE /admin/v1/schema/constraints/:table/:name` — `DROP CONSTRAINT` (or `DROP NOT NULL`).
- Owner/admin role required. Every action logs to `admin.audit_log` and emits an auto-migration file (see §5).

**UI (`dashboard.pluto-schema.tsx`):**
- Pick project → schema → table. Two panels: Indexes, Constraints.
- Add-Index form: columns picker, method dropdown (btree/gin/gist/hash), unique toggle, optional partial-index WHERE.
- Add-Constraint form: type selector, columns, expression (check), FK target.
- Each row has "Drop" with confirm.

---

## 3. Safer SQL editor

**Backend (extend existing SQL runner):**
- `POST /admin/v1/sql/exec` body: `{ sql, params?: any[], read_only?: bool, confirm_destructive?: bool }`.
- Parse first statement (using `pg-query-emscripten`-free regex tokenizer — no new native dep). Classify:
  - `select`, `explain`, `show`, `values` → safe.
  - `insert`, `update`, `delete`, `merge` → destructive-write.
  - `drop`, `truncate`, `alter`, `grant`, `revoke`, `create` → destructive-schema.
- If `read_only=true`: run inside `BEGIN READ ONLY; … ROLLBACK;` and reject anything not classified as safe with `409 read_only_violation`.
- If destructive and `confirm_destructive!==true`: return `409 destructive_requires_confirmation` + classification, no execution.
- Parameters: use `pg` positional `$1..$N` — reject inline `${...}` interpolation attempts (client passes `params`).
- Every exec logs to audit.

**UI (`dashboard.sql.tsx` upgrade):**
- Toggle "Read-only mode" (default ON).
- "Params (JSON array)" textarea.
- On destructive detection, backend returns 409 → UI shows red confirm modal listing the classification and affected keywords; user must type the verb (`DROP`, `DELETE`, …) to proceed. Second call sent with `confirm_destructive:true`.
- Rows-affected / duration / classification badge in results header.

---

## 4. Table-level role permissions

**Backend `0006_governance.sql` (part 2):**
- Enum `admin.table_perm as enum('read','write','admin')`.
- `admin.table_grants(id, project_id, schema, table, role admin.table_perm, principal_type enum('user','api_key_role'), principal_id text)`
- Security-definer `admin.check_table_perm(project_id, schema, table, action, actor_id, api_role) returns bool`.
- Middleware on `/rest/v1/*` calls `check_table_perm` before every request (existing project/API-key checks stay; this narrows further). Deny → 403.

**API:**
- `GET /admin/v1/projects/:id/grants?schema=&table=`
- `POST /admin/v1/projects/:id/grants` — upsert grant.
- `DELETE /admin/v1/projects/:id/grants/:grantId` — revoke.
- Owner/admin only. Audited.

**UI (extend `dashboard.pluto-admin.tsx` with a "Grants" tab):**
- Select project → table → matrix of principals × (read/write/admin) checkboxes. Save writes upserts.

---

## 5. Migration versioning: up / down / rollback

**Backend `0006_governance.sql` (part 3):**
- `admin.migrations(id, project_id null, version bigint, name text, up_sql text, down_sql text, checksum text, applied_at timestamptz null, applied_by uuid null, rolled_back_at timestamptz null)` with unique `(project_id, version)`.
- All schema-mutating admin endpoints (§2) also insert a pending migration row with generated `up_sql` + `down_sql` (e.g. add-index up = `CREATE INDEX`, down = `DROP INDEX`).

**API `/admin/v1/migrations`:**
- `GET /admin/v1/migrations?project_id=` — list with status (`pending|applied|rolled_back`).
- `POST /admin/v1/migrations` — `{ project_id, name, up_sql, down_sql }` create pending.
- `POST /admin/v1/migrations/:id/apply` — run `up_sql` in a transaction, stamp `applied_at`, log audit.
- `POST /admin/v1/migrations/:id/rollback` — run `down_sql` in a transaction, stamp `rolled_back_at`, log audit. Refuses if newer applied migrations depend (later version already applied → 409 with list).
- `GET /admin/v1/migrations/:id/diff` — returns up/down SQL for review.

**UI (`dashboard.pluto-migrations.tsx`):**
- Timeline: version, name, status badge, applied-at.
- Row actions: View SQL (up/down side-by-side), Apply, Rollback (with confirm), Delete pending.
- "New migration" form: name + up + down SQL.

---

## File map

**New backend:**
- `pluto-backend/migrations/0006_governance.sql`
- `pluto-backend/packages/api/src/routes/audit.ts`
- `pluto-backend/packages/api/src/routes/schema.ts` (indexes + constraints)
- `pluto-backend/packages/api/src/routes/grants.ts`
- `pluto-backend/packages/api/src/routes/migrations.ts`
- `pluto-backend/packages/api/src/sql/classifier.ts`
- `pluto-backend/packages/api/src/audit/logger.ts` (helper used across routes)

**Modified backend:**
- `packages/api/src/routes/sql.ts` — read-only + params + destructive gate + audit calls.
- `packages/api/src/routes/rest.ts` — call `check_table_perm` + audit writes.
- `packages/api/src/routes/storage.ts` — audit upload/delete.
- `packages/api/src/server.ts` — register new route modules.

**New UI:**
- `src/routes/dashboard.pluto-audit.tsx`
- `src/routes/dashboard.pluto-schema.tsx`
- `src/routes/dashboard.pluto-migrations.tsx`

**Modified UI:**
- `src/routes/dashboard.pluto-admin.tsx` — add "Grants" tab.
- `src/routes/dashboard.sql.tsx` — read-only toggle, params, destructive confirm.
- `src/components/pluto/Sidebar.tsx` — add Audit / Schema / Migrations links.

---

## Notes / trade-offs

- **No new native deps.** SQL classification uses a small regex tokenizer, not a full parser. Good enough to gate destructive verbs; combined with `READ ONLY` transactions the DB is the ultimate authority.
- **Auto-migrations from §2** keep schema UI actions reproducible without asking the user to hand-write SQL.
- **Grants live above RLS.** Existing RLS policies still apply; table-perm middleware is an additional pre-check, not a replacement.
- **UI history** is intentionally client-side and separate from the server audit log to give instant feedback and to survive short server outages.

Say **"go"** to build all five in this order (backend migration → routes → UI). If you want to slice it (e.g., audit + migrations first, others next turn), tell me which subset.
