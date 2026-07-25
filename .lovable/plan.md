# Operations v2 — Multi-env, Staged Rollout, Rollback, Audit, Backup

This extends the existing `/dashboard/ops` page and the VPS-side `pluto-ops` wrapper. Nothing else on the dashboard changes.

## 1. Environment targets (dev / staging / prod)

Add per-target VPS configuration read from Lovable Cloud secrets — no code changes needed to add a new target.

Secrets convention (both `_URL` and `_SECRET` per env):
```
PLUTO_SANDBOX_URL_DEV / PLUTO_SANDBOX_SECRET_DEV
PLUTO_SANDBOX_URL_STAGING / PLUTO_SANDBOX_SECRET_STAGING
PLUTO_SANDBOX_URL_PROD / PLUTO_SANDBOX_SECRET_PROD   (falls back to existing PLUTO_SANDBOX_URL/SECRET)
```

- `src/lib/pluto/vps-ops.functions.ts`
  - Every server fn accepts `env: 'dev'|'staging'|'prod'` in its input validator (default `prod`).
  - `opsEndpoint(env)` resolves the right URL+secret; returns typed error when a target is not configured.
  - Server fn `listOpsEnvironments()` returns which targets are configured (no secrets exposed).
- `src/routes/dashboard.ops.tsx`: environment switcher pill in the page header; state stored in URL search param `?env=...` so it survives reloads and deep-links.
- VPS-side allow-list (`pluto-ops.sh`): unchanged — allow-list is per host, so each VPS naturally restricts what its own env can do. Prod host can additionally set `PLUTO_OPS_DISALLOW="migrations-apply-force"` etc. (read in dispatcher).

## 2. Staged rollout for restarts

Add a "Staged rollout" mode on the Service Control card. Instead of one-shot restart, dispatcher walks stages:

Default stage plan:
```
1. worker         (sandbox worker)  → health probe
2. realtime       (1 replica)       → health probe
3. api  (canary)  50% of replicas   → health probe + 30s soak
4. api  (full)    remaining replicas
5. nginx-reload
```

- Ops action `service-rollout` accepts `{ plan: 'auto'|'workers-only'|'canary-api'|'full', soakSeconds?: number }`.
- Between stages, dispatcher runs `pluto-ops service-health` and aborts if unhealthy; returns partial result with `stagesCompleted[]`.
- UI shows a vertical stepper with per-stage status/logs; abort button cancels the remaining stages (writes a sentinel file the dispatcher polls).

For single-instance deploys, canary degrades to "restart with health-gated wait" (no true traffic split) — clearly labeled in the UI.

## 3. Rollback (down-migration generator + apply)

- Add `db/rollback.ts` in the backend migration runner: given a target version `N`, it collects each applied migration `>N` in reverse, looks for a paired `NNNN_*.down.sql` file, and streams them into a single transaction. If any migration lacks a `.down.sql`, the plan step reports it as **blocking** — user can still choose "skip missing" to continue (audited).
- New ops actions: `migrations-rollback-plan`, `migrations-rollback-apply` with input `{ target: string, allowMissingDown: boolean, confirm: "ROLLBACK" }`.
- UI: new "Rollback" tab on the Migration card
  - Shows applied migrations table (from `pluto-ops migrations-status`).
  - Click a row → "Rollback to here"; preview shows the generated down-SQL and any missing down files (warning banner).
  - Always runs an automatic backup first (see §5); ties audit rows to the backup id.

## 4. Audit log page (`/dashboard/ops/audit`)

Every ops action (plan, dry-run, apply, rollback-plan/apply, restart, rollout, backup, restore) writes one row via the sandbox worker into a new admin table.

Migration `pluto-backend/migrations/0042_ops_audit.sql`:
```sql
create table if not exists ops_audit (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  actor_user_id uuid,           -- from middleware claims
  actor_email   text,
  env           text not null,  -- dev/staging/prod
  action        text not null,
  service       text,
  params        jsonb not null default '{}'::jsonb,
  ok            boolean not null,
  exit_code     int,
  duration_ms   int,
  hint          text,
  tail          text,           -- truncated to 8KB
  backup_id     uuid            -- fk to ops_backups when applicable
);
create index on ops_audit (created_at desc);
create index on ops_audit (env, action, created_at desc);
grant select on ops_audit to authenticated;
grant all on ops_audit to service_role;
alter table ops_audit enable row level security;
create policy "ops audit visible to admins" on ops_audit for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));
```

- Server fn `listOpsAudit({ env?, action?, actor?, limit, cursor })` streams paginated results.
- Page `/dashboard/ops/audit`: filters by env / action / actor / date range, click a row → drawer with full params + tail + linked backup + linked migration plan output.
- Also **write-through**: `callOps()` in `vps-ops.functions.ts` inserts an audit row (server-side) immediately after every response, so the log is captured even if the VPS action was partially successful.

## 5. Automatic backup + restore safeguard

- Migration `0043_ops_backups.sql`: `ops_backups(id, created_at, env, kind, status, size_bytes, storage_path, sha256, expires_at, notes)`.
- VPS side (`pluto-ops backup-create`): runs `pg_dump -Fc` to `/var/backups/pluto/<env>/<ts>-<sha>.dump`, uploads to configured S3/MinIO if `BACKUP_S3_BUCKET` is set, records row via worker.
- `pluto-ops backup-restore --id <uuid> --confirm RESTORE`: streams the dump back through `pg_restore --clean --if-exists` (blocks unless target is dev/staging OR user typed `RESTORE-PROD`).
- **Migration apply guard**: `applyMigrations` server fn takes `{ confirm: 'APPLY', skipBackup?: boolean }`. Default runs `backup-create` first; if backup fails, apply is aborted unless the user re-submits with `skipBackup: true` (audited with a red-flag).
- Ops page shows a **Backups** card:
  - "Latest backup" chip with age + size + status.
  - Table of last 10 backups per env; each row has "Restore" (opens typed-confirmation modal) and "Download" (signed URL from worker).
- Retention: backups older than 30 days marked `expired`; cleanup job hook noted in dispatcher (optional cron).

## 6. Security & guardrails

- All new server fns keep `.middleware([requirePlutoAdmin])` + `TraceAccessGate permission="manage"`.
- Prod-only extras: typed confirmations use `APPLY-PROD` / `ROLLBACK-PROD` / `RESTORE-PROD` when `env === 'prod'`.
- Sandbox worker `/admin/ops` extended allow-list; unknown actions still 400.
- `pluto-ops.sh` refuses unknown env token (`--env`) and validates service names against per-env `ALLOWED_SERVICES` in `/etc/pluto/ops.conf`.

## 7. Files touched

New:
- `pluto-backend/migrations/0042_ops_audit.sql`, `0043_ops_backups.sql` (+ `.down.sql` pairs)
- `pluto-backend/deploy/pluto-ops-rollback.sh`, `pluto-ops-backup.sh`, `pluto-ops-rollout.sh` (invoked by main wrapper)
- `src/routes/dashboard.ops.audit.tsx`
- `src/components/pluto/ops/EnvSwitcher.tsx`, `RolloutStepper.tsx`, `BackupsCard.tsx`, `RollbackTab.tsx`
- `src/lib/pluto/ops-audit.functions.ts`, `ops-backups.functions.ts`

Edited:
- `src/lib/pluto/vps-ops.functions.ts` (env-aware endpoint, audit write-through, new actions)
- `src/routes/dashboard.ops.tsx` (env switcher, staged rollout, backups card wire-up)
- `pluto-backend/sandbox-worker/sandbox-worker.mjs` (extend `/admin/ops` allow-list, params passthrough)
- `pluto-backend/deploy/pluto-ops.sh` (dispatch to new sub-scripts + `--env` handling)
- `pluto-backend/deploy/install-pluto-ops.sh` (install new sub-scripts, `/etc/pluto/ops.conf` scaffold)
- `src/components/pluto/Sidebar.tsx` (add "Audit log" under Operations)

## 8. Rollout order

1. Migrations 0042/0043 + audit/backups server fns (safe on their own).
2. Env switcher + `env` param plumbing.
3. Backup guard around existing `migrations-apply`.
4. Rollback tab + dispatcher.
5. Staged rollout stepper.
6. Audit page.
