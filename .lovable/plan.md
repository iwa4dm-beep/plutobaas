# Plan: Domain resolution, wildcard TLS auto-renew, and dashboard visibility

This bundles six related items into one coherent workstream so the sandbox, DNS, TLS, and dashboard all speak the same language about a slug.

## Scope

1. **Site-mapping API** — one source of truth mapping `slug → { apiUrl, appUrl, previewUrl, apex, workspaceId }`, with optional auto-trigger of DNS+TLS.
2. **Wildcard TLS auto-renew + alerts** for `*.app.timescard.cloud`.
3. **DNS auto-heal wizard** that turns HTTP 000 into an actionable diagnosis (DNS missing / cert missing / nginx down / worker down / bundle missing) with a one-click repair command.
4. **Dashboard workspace/app list fetch fix** so the app/workspace list reliably renders.
5. **UI status panel** for a slug: Auto Deploy pushed? Migrations applied? Bundle unpacked? Placeholder vs real?
6. **Auto-seed on `slug_not_found`** inside `verify-deploy.sh` (already partial) + inside the worker `/site-status` path so the manual `seed-slug.sh` step disappears.

## Deliverables

### 1. Site-mapping API (dashboard-side, TanStack server functions)

- `src/lib/pluto/site-mapping.functions.ts`
  - `getSiteMapping({ slug })` → `{ slug, workspaceId, apex, apiUrl, prodUrl, previewUrl, workerBase, sandboxPort, dns: {...}, tls: {...} }`
  - `upsertSiteMapping({ slug, workspaceId, apex? })` → persists override rows in `admin.site_mappings`
  - `triggerAutoHeal({ slug, actions: ['dns','tls','seed','reload'] })` → calls VPS repair endpoint (see §3)
- Migration `0039_site_mappings.sql`
  - `admin.site_mappings(slug pk, workspace_id, apex, api_host, prod_host, preview_host, updated_at)` + grants + RLS (owner/admin via `has_role`).
- `src/routes/api/public/site-mapping.$slug.ts` (GET) — public read-only resolver returning the mapping; used by the sandbox worker and by CLI health checks. Anon-safe (no secrets in body).

### 2. Wildcard TLS auto-renew + alerts

- `pluto-backend/deploy/tls-renew.sh` — wraps `certbot renew --deploy-hook 'systemctl reload nginx'`, logs to `/var/log/pluto/tls-renew.log`, writes a `status.json` (last-run ts, success, cert not-after per domain).
- `pluto-backend/deploy/systemd/pluto-tls-renew.service` + `.timer` (daily, `RandomizedDelaySec=1h`) — installed by `install-wildcard-tls.sh` if missing.
- `pluto-backend/deploy/tls-alert.sh` — reads `status.json` and cert expiry; if `not_after < now+14d` OR last run failed, POSTs to `/api/public/tls-alert` (HMAC-signed with `TLS_ALERT_SECRET`). Runs on the same timer.
- `src/routes/api/public/tls-alert.ts` — verifies HMAC, inserts a row into `admin.tls_events`, emits an in-app notification for admins.
- Dashboard shows a red banner when any cert is `expiring`/`failed`.

### 3. DNS + Auto-Heal wizard

- `pluto-backend/deploy/diagnose-slug.sh <slug>` — replaces the "checklist" text at end of `verify-served-site.sh` with real probes:
  - `dig +short <slug>.<apex>` vs. detected VPS IP
  - `openssl s_client` SAN check for `*.<apex>`
  - `systemctl is-active nginx pluto-sandbox-worker`
  - `/site-status/<slug>` on `127.0.0.1:8787`
  - Disk state at `/var/lib/pluto/sites/<slug>`
  - Emits a JSON `{ cause, fix_command }`.
- `verify-served-site.sh` calls it whenever a probe returns 000 or non-2xx and prints the `fix_command` inline (DNS → `ensure-wildcard-dns.sh`; TLS → `fix-wildcard-ssl.sh`; missing slug → `seed-slug.sh`; worker → `refresh-worker.sh`).
- Dashboard `HealDialog` component: calls `triggerAutoHeal` from §1 and streams progress.

### 4. Dashboard workspace/app list fetch fix

- Audit `src/routes/_authenticated/index.tsx` (or dashboard root) + the `listWorkspaces` / `listProjects` server functions.
  - Ensure both use `context.queryClient.ensureQueryData` + `useSuspenseQuery` (not `useEffect` + `fetch`).
  - Ensure server function uses `requireSupabaseAuth` and reads workspaces where `owner_id = context.userId OR EXISTS(workspace_members)`.
  - Grants: verify `authenticated` has `SELECT` on `admin.workspaces`, `admin.workspace_members`, `admin.projects` (per 0038 self-heal, add anything still missing in `0039`).
- Add `errorComponent` + `notFoundComponent` and an empty-state CTA ("Create your first workspace").

### 5. UI status panel per slug

- `src/routes/_authenticated/projects/$slug.status.tsx`
- Server fn `getSlugStatus({ slug })`:
  - `deployment`: latest `admin.deployments` row (state, started_at, finished_at, bundle_sha, size).
  - `migrations`: `admin.migration_runs` latest per project (applied vs pending count).
  - `bundle`: fetches `https://api.<apex>/site-status/<slug>` → parses `{ release, placeholder, sizeBytes, servedAt }`.
  - `dns`, `tls`: pulled from §1/§2.
- UI: 4 traffic-light cards (Auto Deploy · Migrations · Bundle · DNS/TLS) with timestamps and a "Heal" button per row.

### 6. Auto-seed on `slug_not_found`

- Worker side (`sandbox-worker/sandbox-worker.mjs`): when `/site-status/<slug>` would return 404 and the request carries `X-Pluto-Auto-Seed: 1` from a trusted source, seed a minimal placeholder in-process (same layout `seed-slug.sh` writes) and return 200 with `placeholder: true, autoSeeded: true`.
- `verify-deploy.sh`: already auto-seeds when root — extend to also POST to `/api/public/site-mapping/<slug>/heal` so the dashboard is notified.
- Server fn `triggerAutoHeal` (§1) with `actions: ['seed']` calls the worker's admin `/seed-slug` endpoint (secret-authed) — used by the dashboard Heal button.

## Technical notes

- All new server functions use `createServerFn` + `requireSupabaseAuth` where user context matters; public read (`/api/public/site-mapping/*`) uses a publishable-key client and returns only non-secret fields.
- Worker gets one new authenticated endpoint `POST /admin/seed-slug` guarded by the existing shared `SECRET` header.
- DNS auto-heal continues to use `ensure-wildcard-dns.sh` (Cloudflare token at `/etc/letsencrypt/cloudflare.ini`).
- No new secrets requested up front; `TLS_ALERT_SECRET` is generated server-side via `generate_secret` when the timer is first installed.

## Rollout order

1. Migration `0039_site_mappings.sql` + grants.
2. Site-mapping server fns + public resolver route.
3. Worker `/admin/seed-slug` + `X-Pluto-Auto-Seed` behavior.
4. `diagnose-slug.sh` + `verify-served-site.sh` integration.
5. `tls-renew.sh` + systemd timer + `tls-alert.sh` + `/api/public/tls-alert` route.
6. Dashboard: workspace list fix → per-slug status panel → Heal dialog → TLS banner.

## Out of scope

- Custom (non-`app.timescard.cloud`) domain automation — separate flow via `reconcile-domains.sh`.
- Changing worker's on-disk layout or migration engine.
- Adding a queue/broker for repair jobs — repair actions stay synchronous with progress streamed over SSE.

Approve this and I'll implement in the order above; each step is independently verifiable with `verify-deploy.sh <slug>`.
