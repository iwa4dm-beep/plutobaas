# Automated VPS Migration & Service Restart

লক্ষ্য: নতুন migration apply করা এবং service restart করা — দুটোই dashboard থেকে এক ক্লিকে, VPS-এ SSH না করে।

## কোথায় বসাবো (Placement)

নতুন dedicated page: **`/dashboard/ops`** (Sidebar → "Operations")

কারণ:
- `database-import` = schema import/connection wizard, একবারের কাজ
- `data-studio` = row-level browsing
- Ops = recurring lifecycle (migration apply, service restart, health)। এদের আলাদা mental model দরকার।

পাশাপাশি existing `OneClickFixPanel` / `MigrationRunner` কার্ডগুলোকেও এই Ops page-এ consolidate করব যাতে "কোথায় কী চালাই" সেই confusion না থাকে।

## Backend (server functions)

নতুন file: `src/lib/ops/vps-ops.functions.ts` — সব `requireSupabaseAuth` + `manage` role gate।

1. **`planMigrations`** — VPS API-তে `POST /admin/migrations/plan` কল করে pending list, drift, checksum ফেরত দেয়। কিছু apply করে না।
2. **`dryRunMigrations`** — `POST /admin/migrations/dry-run`; transaction-এ চালিয়ে rollback করে, per-file success/error স্ট্রিম করে।
3. **`applyMigrations`** — `POST /admin/migrations/apply`; SSE/chunked stream করে log line-by-line।
4. **`restartService`** — `POST /admin/services/restart` with `{ service: "api" | "realtime" | "worker" | "nginx-reload" }`; allow-listed, arbitrary shell নয়।
5. **`serviceHealth`** — `GET /admin/services/health`; প্রতিটা service-এর uptime, last restart, error count।
6. **`opsHistory`** — সাম্প্রতিক migration runs (`migration_boot_runs` table থেকে) + restart events।

VPS side: pluto-backend API-তে ইতিমধ্যে migration runner আছে (`db/migrate.ts`)। যা যোগ করতে হবে:
- `/admin/migrations/*` HTTP endpoints যা migration script কে সাবপ্রসেস হিসেবে চালিয়ে stdout stream করে।
- `/admin/services/restart` যা systemd unit বা docker compose service কে allow-list থেকে restart করে (sudo rule সেটআপসহ)।
- Auth: existing service_role JWT + IP allow-list (optional)।

## Frontend (নতুন page)

`src/routes/dashboard/ops.tsx` — চারটে কার্ড:

```text
┌─ Migration Control ────────────────┐  ┌─ Service Control ────────┐
│ [Plan] [Dry-run] [Apply]           │  │ api      ● running  [↻]  │
│ pending: 3   drift: 0              │  │ realtime ● running  [↻]  │
│ ─ live log stream ─                │  │ worker   ● running  [↻]  │
│ → 0042_...sql  ✓ 42ms              │  │ nginx    ● reload   [↻]  │
└────────────────────────────────────┘  └──────────────────────────┘

┌─ Run History (last 20) ────────────────────────────────────────┐
│ 2026-07-25 04:12  apply   ok    3 files    admin@…             │
│ 2026-07-25 03:58  restart api   ok         admin@…             │
└────────────────────────────────────────────────────────────────┘
```

Reusable pieces:
- `MigrationRunner.tsx` existing component রিফ্যাক্টর করে এখানে বসাবো।
- `ServiceControlCard.tsx` — status polling (every 10s) + restart button with confirm dialog।
- `OpsHistoryTable.tsx` — paginated।

## Safety

- সব mutating action-এ confirm dialog + typed confirmation (service name টাইপ করতে হবে restart-এর জন্য)।
- RBAC: `manage` permission (existing `TraceAccessGate` pattern reuse)।
- Rate limit: প্রতি service ৩০s cooldown।
- সব action `error_events` + নতুন `ops_events` table-এ log হবে (trace_id সহ)।

## Deliverables

1. Migration `0042_ops_events.sql` — audit log।
2. VPS API routes (`pluto-backend/packages/api/src/routes/admin-ops.ts`) — migrations + services।
3. Systemd sudoers snippet (`deploy/systemd/pluto-ops-sudoers`) — restart permission for pluto user।
4. `src/lib/ops/vps-ops.functions.ts` — 6টা server function।
5. `src/routes/dashboard/ops.tsx` + 3টা component।
6. Sidebar-এ "Operations" link।
7. E2E test: `e2e/ops-page.spec.ts` — plan → dry-run → apply → restart flow (mocked)।

## Rollout

Phase 1: Read-only (plan + health + history) — risk শূন্য।
Phase 2: Dry-run enable।
Phase 3: Apply + restart with confirmation।

Approve করলে তিনটা phase একসাথে ship করব, কারণ frontend gate দিয়ে phase toggle করা যায়।
