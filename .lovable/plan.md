This is Phase 29–30 scope — a large batch. I'll split it into two waves so each ships verifiable and reviewable. Approve and I'll build wave 1 immediately, then wave 2.

## Wave 1 — Infra, presence, audit, SSE alerts

### 1. CI: typecheck + vitest
- `.github/workflows/ci.yml`: install with `bun install --frozen-lockfile`, run `bunx tsgo --noEmit`, run `bunx vitest run`.
- Add `test` and `typecheck` scripts to `package.json`.

### 2. Presence hardening + dashboard indicator
- `src/lib/pluto/live.ts` `rt2.subscribePresence`: keep exponential backoff, add `onStatus("connecting"|"live"|"retrying"|"failed", attempt)` callback, cap attempts (configurable, default 8) before emitting `failed`, jittered backoff.
- New `PresenceIndicator` component (dot + tooltip: channel, attempts, last error) surfaced on `/dashboard/realtime`.
- Extend the presence retry vitest with cases for `onStatus` transitions and permanent failure.

### 3. Alert SSE banner (Phase 26 follow-up)
- Backend: reuse `pluto_broadcast` NOTIFY pipe already used by `audit.ts`. In `metering.ts::maybeFireAlert`, broadcast a `system:usage_alert` event alongside DB insert.
- Backend: add `/usage/v1/alerts/stream` SSE endpoint that fans out `system:usage_alert` for the caller's workspace.
- SDK: `usage.streamAlerts(onEvent)`; dashboard swaps the 15s poll for the stream, keeps a fallback poll every 60s when SSE fails.

### 4. Webhook delivery status panel
- Migration `0028_webhook_deliveries.sql`: `webhook_deliveries` table (webhook_id, alert_id, status_code, response_time_ms, error, attempt, delivered_at, next_retry_at, payload_hash).
- Retry policy in webhook dispatch: up to 5 attempts with exponential backoff (30s → 8m).
- Endpoints: `GET /usage/v1/webhooks/:id/deliveries` (paginated), `POST /usage/v1/webhooks/:id/redeliver/:delivery_id`.
- UI: new "Deliveries" collapsible panel per webhook row on `/dashboard/usage`.

### 5. Audit Log page
- New `/dashboard/audit-log` route (dedicated view for restore + quota + tokens + function changes — the existing `/dashboard/audit` shows raw admin API audit; this filters/decorates for the newer workflows).
- SDK: `audit.list({ action_prefix, actor, status, since, until, limit, offset })` calling existing `/admin/v1/audit`.
- UI: filter chips for `backup.restore.*`, `quota.set`, `functions.*`, `tokens.*`; badge for `dry_run` vs `ok`; expandable metadata JSON.

## Wave 2 — Dashboard scale + restore wizard depth

### 6. Pagination / sort / CSV export (4 dashboards)
- Add a small `usePaginatedTable` hook (client-side page + sort state) and a `CsvExportButton` helper (`src/lib/pluto/csv.ts`).
- Apply to `/dashboard/realtime` (messages), `/dashboard/vector` (matches), `/dashboard/functions` (invocations), `/dashboard/backups` (exports). Backends already return arrays; keep sort/pagination client-side for the first pass, add server offset/limit to invocations + restore listing where it matters.

### 7. Restore schema-compatibility diff
- Backend: extend `/backups/v1/restores/preview` to compute a diff between the export's schema DDL and the target branch's live schema (columns present/missing, type mismatches, missing tables). Reuse existing `information_schema` reads in the branching module.
- Response shape: `{ added_tables, removed_tables, columns: [{ table, column, source_type, target_type, action }] }`.
- UI: new "Compatibility" step in the restore wizard shown before "Apply", with a colored diff table; "Allow incompatible schema" is disabled until user acknowledges the diff.

### 8. E2E tests for restore wizard
- Add Playwright (dev-only) + a `bun test:e2e` script. Not wired into CI by default (documented separately) — tests require the running dev server.
- Scenarios: open wizard → dry-run preview shows compatibility diff → progress stream ticks → cancel; live restore requires typing `RESTORE`; close button stops SSE.

## Technical details

- SSE endpoints use the existing `pg_notify('pluto_broadcast', …)` mechanism plus a per-connection filter on `{channel: 'system:usage_alert', workspace_id}`.
- `webhook_deliveries` has RLS `service_only` matching the rest of the workspace admin surface; `GET` goes through `requireWorkspaceAdmin`.
- Vitest scope stays unit-only; e2e is separate.
- CSV export runs on already-loaded rows in the current sort order — no server-side export endpoint.

## Out of scope (call out for later)

- Real distributed tracing / OpenTelemetry for edge invocations.
- Server-side full-table CSV export (would need streaming download endpoints).
- Multi-region webhook retries with per-region logs.

Reply with "go" to start Wave 1, "wave 2 first" to reorder, or edits to the split.