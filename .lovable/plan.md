
# Pluto Auto-Deploy Studio — 360° One-Click Import, Wire & Go-Live

একটি নতুন পেজ `/dashboard/auto-deploy` তৈরি করা হবে যেখানে user তিনটি উপায়ে project দিতে পারবে (GitHub connect / Git repo URL / ZIP upload) এবং শেষ পর্যন্ত একটি live URL পাবে — Pluto BaaS backend সহ পুরোপুরি wired ও deployed। বেশিরভাগ building blocks (analyzer, frontend-rewriter, migration-converter, github-loader, vps-deployer, sandbox-worker, custom-domain reconciler) already project-এ আছে — এই phase সেগুলোকে একটি single guided wizard-এ stitch করবে।

## User Flow (page-level)

```text
Step 1  Source        → GitHub connect | Git URL | ZIP upload
Step 2  Analyze       → framework, tables, routes, env, risks
Step 3  Plan          → tables, endpoints, rewrites, RLS (editable)
Step 4  Wire Backend  → migrations apply + secrets + anon key
Step 5  Build+Deploy  → frontend rewrite → build → sandbox host
Step 6  Live          → https://<slug>.apps.timescard.cloud  ✅
                        (+ optional custom domain wizard)
```

প্রতিটি step একটি stepper UI-তে থাকবে, retry/cancel/logs stream সহ (SSE)।

## What Gets Built

### 1. New route & UI (`src/routes/dashboard/auto-deploy.tsx`)
- 6-step stepper (Source → Analyze → Plan → Wire → Deploy → Live)
- Real-time log panel (SSE from deploy endpoint)
- Editable plan preview (tables, RLS, endpoint mapping)
- Final "Live URL" card with copy, open, redeploy, add custom domain buttons

### 2. Source adapters (reuse existing)
- **GitHub connector**: `standard_connectors--connect` → `github-loader.functions.ts` (already exists) — private repo support via gateway
- **Git URL**: same `fetchGithubZip` server fn accepts `owner/repo` or full URL + optional ref
- **ZIP upload**: direct File → existing `analyzeZip()` pipeline

### 3. Orchestrator server function (`src/lib/pluto/auto-deploy.functions.ts` — new)
Single `runAutoDeploy({ source, workspaceId, options })` server fn that internally chains:
1. `analyzeZip` (existing) → `AnalyzeResult`
2. `buildIntegrationPlan` (existing) → tables + endpoints + rewrites
3. `buildBundle` (existing `autoconnect/bundler.ts`) → frontend.zip + migrations.zip
4. `deployAll` (existing `vps-deployer.functions.ts`) → ensureInfra + pushMigrations + uploadBundle + verifyDeploy
5. Register slug + emit final URL

Progress streamed via existing `serve-progress.sh` pattern or SSE route.

### 4. Slug + subdomain provisioning
- Auto-generate slug (`<repo>-<hash>`) unique per workspace
- Insert row in existing `admin.projects` table
- Sandbox worker (already installed) picks up the extracted bundle at `/var/lib/pluto/sites/<slug>/`
- Nginx `wildcard-app.conf` (already deployed in Phase E) serves `https://<slug>.apps.timescard.cloud` automatically

### 5. Auto-wired Pluto backend
- Migrations applied via `deployAll` → real Postgres schema + RLS + GRANTs
- Anon key minted from `admin.api_keys` (existing table) and injected into deployed frontend as `VITE_PLUTO_ANON_KEY`
- `VITE_PLUTO_URL=https://api.timescard.cloud` baked in at build time
- Storage buckets / edge functions provisioned if the plan requires them

### 6. Optional custom domain step
- After live URL works, offer "Attach custom domain" — reuses Phase D `pluto-domain-reconciler` (already installed)
- User adds A/TXT records → reconciler picks up within 60s → HTTPS auto-issued

### 7. Public API (already exists, wire into UI)
- `POST /api/pluto/deploy` (already present) — used as the actual worker endpoint
- New `GET /api/pluto/deploy/status?jobId=…` SSE stream for the UI progress panel

## Technical Details

**Files to create**
```
src/routes/dashboard/auto-deploy.tsx              # main page (stepper UI)
src/routes/dashboard/auto-deploy.$jobId.tsx       # resumable job view
src/routes/api/pluto/deploy-status.ts             # SSE progress endpoint
src/lib/pluto/auto-deploy.functions.ts            # orchestrator server fn
src/lib/pluto/auto-deploy-jobs.ts                 # in-DB job state helper
src/components/pluto/AutoDeployStepper.tsx        # step UI
src/components/pluto/AutoDeployLogs.tsx           # SSE log panel
src/components/pluto/PlanEditor.tsx               # editable plan (reuses types)
pluto-backend/migrations/0038_auto_deploy_jobs.sql # jobs + live_sites tables
docs/AUTO-DEPLOY-STUDIO.md                        # user + operator runbook
e2e/auto-deploy.spec.ts                           # full pipeline E2E
```

**Files to edit (small)**
```
src/components/pluto/Sidebar.tsx        # add "Auto-Deploy Studio" entry
src/lib/pluto/vps-deployer.functions.ts # emit progress events per step
```

**Migration `0038_auto_deploy_jobs.sql`** — creates `admin.auto_deploy_jobs` (id, workspace_id, source_kind, source_ref, status, step, logs jsonb, live_url, created_at) and `admin.live_sites` (slug, workspace_id, bundle_path, deployed_at, custom_domain). Full GRANTs + RLS per project rule.

**Reuse (no changes needed)**
- `autoconnect/analyzer.ts`, `frontend-rewriter.ts`, `migration-converter.ts`, `bundler.ts`, `env-mapper.ts`
- `pluto/vps-deployer.functions.ts` (`deployAll`)
- `github-loader.functions.ts` (GitHub + Git URL)
- Phase D reconciler, Phase E wildcard nginx, Phase F quotas
- `sandbox-worker.mjs` (ZIP unpacker + host)

**Security**
- All server fns use `requireSupabaseAuth` + workspace-role check
- Signed bundle uploads (SHA256 manifest, already produced by `zip-verify.ts`)
- Per-workspace quota check (Phase F `project_usage_and_quotas`) before deploy starts
- ZIP size cap 200 MB (existing)

## Verification
- New `e2e/auto-deploy.spec.ts` drives all 3 source types end-to-end against localhost
- Unit tests for orchestrator step sequencing + failure/rollback
- Manual smoke: import a small Vite+Laravel repo → live URL responds 200 within ~2 min

## Out of Scope (future phases)
- Multi-region deploy
- Blue/green preview environments per PR
- Non-Node runtimes (Python/Go apps)

---

Approve করলে এই plan অনুযায়ী implementation শুরু করব।
