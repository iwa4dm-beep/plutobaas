# Bulk delete hardening: modal, jobs, audit, soft-delete

Four features touching dashboard bulk delete, VPS worker, DB, and a new recycle bin. All work on top of what already shipped (`purgeVpsSlug`, bulk-delete in `dashboard.projects.tsx` / `dashboard.users.tsx`).

## 1. Confirmation modal + per-item error summary

Replace the `confirm()` calls in `dashboard.projects.tsx` and `dashboard.users.tsx` with a shared `<BulkDeleteDialog>` component:

- Lists every target (name + slug/email) as a checklist you can still uncheck.
- Requires typing `DELETE` to enable the button (matches GitHub / Vercel norms).
- Shows a "Purge VPS site directory too" toggle (projects only), default on.
- Runs deletions in parallel with `Promise.allSettled`, streams per-item status back into the dialog (pending → ok / db-failed / vps-failed) with the exact error message and — for VPS failures — the `hint` from `purgeVpsSlug`.
- Dialog stays open after the run so you can copy failures, retry only failed rows, or close.

Files: `src/components/pluto/BulkDeleteDialog.tsx` (new), and rewire the two dashboard routes.

## 2. Background job with live status for VPS purges

Purges become jobs so long / flaky VPS calls don't block the UI.

- New table `public.vps_purge_jobs` (id, workspace_id, slug, status: queued|running|ok|failed, attempts, last_error, removed jsonb, created_by, created_at, updated_at).
- New server functions in `src/lib/pluto/vps-purge-jobs.functions.ts`:
  - `enqueueVpsPurge({ slug, projectId })` — inserts a queued row, kicks off `runVpsPurgeJob` (fire-and-forget), returns job id.
  - `runVpsPurgeJob({ id })` — marks running, calls existing `purgeVpsSlug` handler, records result + attempts.
  - `retryVpsPurgeJob({ id })` — resets failed → queued and re-runs.
  - `listVpsPurgeJobs({ limit, status? })` — for dashboard polling.
- Bulk delete flow enqueues one job per project instead of awaiting purge inline. Dialog subscribes via `useQuery` with 1.5s poll until every job is terminal.
- New route `dashboard.jobs.tsx` shows the full queue with retry buttons and last-error detail.

## 3. Admin audit log for deletes

- New table `public.admin_delete_audit` (id, actor_id, actor_email, action: delete_user|delete_project, target_id, target_label, db_rows_removed int, vps_purge_job_id nullable, vps_removed_paths jsonb, vps_errors jsonb, created_at).
- Wrap the existing `admin.projects.remove` / `admin.users.remove` calls in a new server function `recordDeleteAudit` that inserts one row per target as soon as the DB delete resolves; VPS job id is patched in when the job finishes.
- New route `dashboard.audit.deletes.tsx`: filterable list (by actor, action, date range) with links to job detail. Superadmin only via existing `TraceAccessGate`.

## 4. Soft-delete + configurable undo window

Instead of dropping DB rows immediately, mark them deleted and purge later.

- Migration: add `deleted_at timestamptz`, `deleted_by uuid`, `purge_after timestamptz` to `admin.projects` and `admin.users`. All existing list endpoints add `deleted_at is null`.
- New settings row `admin.system_settings.soft_delete_window_minutes` (default 30). Editable from `dashboard.ops.settings.tsx`.
- Delete flow becomes:
  1. Set `deleted_at = now()`, `purge_after = now() + window`, `deleted_by = actor`.
  2. Enqueue VPS purge job but with `run_after = purge_after` — worker skips until then.
  3. Audit row records "soft delete".
- New "Recycle bin" route `dashboard.trash.tsx`:
  - Lists soft-deleted users + projects with time-remaining.
  - **Restore** (clears `deleted_at`, cancels queued job).
  - **Purge now** (sets `purge_after = now()`, wakes job).
- Sweeper: extend the existing worker tick to hard-delete rows past `purge_after` and run their VPS jobs.

## Technical notes

- Only superadmins see the audit + trash routes; existing `useSuperAdmin` hook gates them.
- All new tables get the standard `GRANT ... TO service_role` + RLS-enabled + policies scoped to `has_role(..., 'admin')` per `docs/security/core-tables-rls.md`.
- Purge jobs run inside a single-flight lock keyed by slug so retries can't stomp each other.
- `purgeVpsSlug` is unchanged — the job wrapper calls it.
- Rollout order: migration → server fns → dashboard components → new routes → wire bulk-delete to jobs.

## Out of scope

- Email/Slack notifications on purge failure (already covered by Ops webhooks — reuse if wanted later).
- Cross-region replication of the audit log.
- Bulk restore from trash (single-row restore only in v1).
