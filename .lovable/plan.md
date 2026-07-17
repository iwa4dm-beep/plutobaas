
# Observability & Logs System — ধাপে ধাপে Plan

চারটি scope-ই আপনি select করেছেন এবং data source হবে **VPS worker + nginx access logs**। আমি এটাকে ৫টি ধাপে ভাগ করছি যাতে প্রতি ধাপ শেষে একটা কার্যকরী feature live হয় — পরের ধাপ শুরু করার আগে আপনি verify করতে পারবেন।

## Data model (একবার তৈরি হবে, সব ধাপে reuse হবে)

Lovable Cloud-এ ২টা table:

**`request_logs`** — worker + nginx থেকে আসা প্রতিটা HTTP request-এর row:
- `id`, `ts`, `deployment_id` (nullable), `workspace_id`, `slug`
- `environment` (`production` / `preview` / `sandbox`)
- `host`, `route` (matched pattern), `request_path`, `request_method`
- `status_code`, `request_type` (`html`/`api`/`asset`/`webhook`)
- `service` (`worker` / `nginx` / `edge`), `resource` (`sites`/`sandbox`/`api`/...)
- `cache` (`HIT`/`MISS`/`BYPASS`/null), `duration_ms`, `bytes`
- `console_level` (nullable — `error`/`warn`/`info`/`debug`), `message`
- `branch` (nullable), `workflow_run_id`, `workflow_step` (nullable)

**`workflow_runs`** — Auto-Deploy pipeline runs (existing history table extend):
- `id`, `slug`, `branch`, `commit_sha`, `started_at`, `finished_at`, `status`
- `deployment_id`, `steps` (jsonb — array of {name, status, duration, log_url})

RLS: workspace-scoped read via `has_role` + workspace membership; service-role write only.

## ধাপ ১ — Ingestion pipeline (backend foundation)

1. **Worker patch** (`sandbox-worker.mjs`): প্রতিটা request-এর জন্য একটা structured JSON line stdout-এ log করবে (fields উপরের model অনুযায়ী)। ইতিমধ্যে filesystem write ছাড়াই journald ধরবে।
2. **nginx**: `log_format json_combined` যোগ করে `access.log`-এ JSON format-এ লিখবে।
3. **Log shipper** (`pluto-backend/deploy/install-log-shipper.sh`): একটা ছোট Node daemon (`pluto-log-shipper`) যেটা
   - journald + nginx access log tail করে
   - JSON parse করে
   - batch (500 rows / 2s) করে TanStack public server route `POST /api/public/ingest/logs` -এ পাঠায় HMAC signature সহ
4. **Ingestion endpoint** (`src/routes/api/public/ingest/logs.ts`): signature verify → Zod validate → `request_logs` bulk insert (`supabaseAdmin`)।
5. **Systemd unit** + secret (`PLUTO_LOG_INGEST_SECRET`) auto-generated।

**Verify**: `curl` diagnostic দেখাবে `select count(*) from request_logs where ts > now() - interval '1 minute'` > 0.

## ধাপ ২ — Unified Logs Explorer (`/dashboard/logs`)

নতুন route + query surface। Server function `queryLogs` (RLS-scoped) সব ১৫টা dimension-এ filter নেয়। URL search params (validated via `zodValidator + fallback`) — bookmarkable/shareable।

UI (single page, keyboard-first):
- **Left rail — Facets**: প্রতিটা dimension-এর জন্য top-N counts (Environment, Status Code, Route, Request Type, Service, Cache, Host, Console Level, Branch, Workflow Step, Deployment ID, Resource, Request Method)। ক্লিক = filter toggle।
- **Top bar**: full-text `Contains` box (matches `message` + `request_path`), time range picker, refresh interval।
- **Center**: virtualized table (ts, level/status, method, path, duration, deployment) — row expand করলে full JSON।
- **Right drawer**: selected row-এর deployment + workflow_run cross-link।

Empty/error/loading states + CSV export।

## ধাপ ৩ — Auto-Deploy Studio-তে filter integration

বর্তমান `dashboard.auto-deploy.tsx`-এ:
- History list-এর উপরে একটা compact filter bar (Environment, Status Code, Deployment ID, Route, Branch)।
- প্রতিটা deploy row-এ **"View logs"** button → Logs Explorer-এ pre-filtered navigate (`?deployment_id=...&ts>=started_at`)।
- Health check panel-এ prod-live 4xx/5xx rate mini-chart (last 15 min from `request_logs`)।

## ধাপ ৪ — Served-site diagnostics extension (live tail)

`ServedSiteDiagnosticsPanel`-এ নতুন tab **"Live requests"**:
- `queryLogs({ slug, since: now-5m })` polling প্রতি 3s
- Path, Status, Method, Cache, duration মিনি table
- **"Tail in Explorer"** button → `/dashboard/logs?slug=...&auto_refresh=1`

## ধাপ ৫ — Workflow/CI Runs viewer (`/dashboard/workflows`)

- Auto-Deploy pipeline runs list — Branch × Workflow Run × Deployment ID cross-index
- Detail view: steps timeline (each step name + status + duration) + step-level log filter shortcut → Logs Explorer scoped to that `workflow_run_id + workflow_step`
- Retry / rerun button (existing auto-deploy trigger reused)

---

## Technical highlights (for reference)

- **Cost control**: retention policy — DELETE FROM request_logs WHERE ts < now() - interval '14 days' via `pg_cron`; asset requests (`request_type='asset'`) retained only 3 days.
- **Indexes**: `(workspace_id, ts DESC)`, `(slug, ts DESC)`, `(deployment_id)`, GIN on `message` for `Contains` search.
- **Security**: ingest endpoint under `/api/public/*` with HMAC (`PLUTO_LOG_INGEST_SECRET`); read via `requireSupabaseAuth` server fns; RLS enforces workspace scope; no PII in log lines (auth headers stripped worker-side).
- **Performance**: virtualized table (`@tanstack/react-virtual`), facet counts computed via a single `queryLogs` call returning `{rows, facets}`; server pagination (keyset on `ts`).

---

## Order of delivery

আমি shipped-per-step model-এ কাজ করব:
1. ধাপ ১ (schema + ingest endpoint + shipper script) — VPS-এ shipper install করার পর ধাপ ২ শুরু।
2. ধাপ ২ (Explorer) — এটাই সবচেয়ে বড়; শেষ হলে সব বাকি ধাপ এর উপর build করে।
3. ধাপ ৩, ৪, ৫ — একই query surface reuse, তাই দ্রুত।

**Priority fields আপনি text answer-এ দেননি** — আমি ধরে নিচ্ছি সব ১৫টাই first-class (facet + filter), শুধু "Workflow Run/Step/Branch" ধাপ ৫-এ populate হবে (ধাপ ১-এ column present কিন্তু nullable)।

Plan approve করলে ধাপ ১ থেকে শুরু করব।
