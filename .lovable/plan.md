## Repo audit (already done)

`iwa4dm-beep/dubaiborkahouse` = Lovable-generated Vite + React + shadcn e-commerce app.

| Piece | Count | Note |
|---|---|---|
| SQL migrations | 28 files, ~1,381 lines | `supabase/migrations/` — tables, RLS, functions, triggers |
| Edge functions | 10 | admin-ai-agent, customer-chat, generate-invoice, google-merchant-feed, send-* (email/whatsapp/campaigns) |
| Frontend | Vite + React + shadcn | Uses `@lovable.dev/cloud-auth-js` + `@supabase/supabase-js` |
| Target subdomain | `app2.timescard.cloud` | User-owned, DNS control needed |

## Scope check — what "migrate to Pluto BaaS" means

Pluto BaaS = this app. It provides Postgres + Auth + Data API + Storage + Edge Functions + Realtime. Migration = point the cloned repo at **your** Pluto backend instead of the original Lovable Cloud/Supabase project.

**Two parts, both required for "live":**

**A. Backend (Pluto BaaS side — new tenant on your instance)**
1. Create a new workspace/project inside Pluto for this tenant.
2. Run all 28 SQL migrations against that workspace's Postgres — table order preserved, RLS policies attached, functions/triggers created.
3. Port each of the 10 edge functions to Pluto Edge Functions v7 (Deno → runtime shim); wire their secrets (Resend, WhatsApp, Google Merchant, OpenAI, etc.) via Pluto's secret store.
4. Assign backend a stable subdomain: `api.app2.timescard.cloud` (recommended) or `app2-api.plutobaas.app`.
5. Point DNS: `api.app2.timescard.cloud` CNAME → Pluto ingress.

**B. Frontend (the cloned Vite app — deployed separately)**
1. Fork / clone the repo into a new Lovable project (or reuse an existing hosting flow).
2. Swap Supabase client bootstrap → point `VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY` to the new Pluto workspace's URL + anon key.
3. Replace `@lovable.dev/cloud-auth-js` calls with Pluto's compatible auth SDK (drop-in shim exists in this codebase under `src/lib/pluto/`).
4. Build + publish to `app2.timescard.cloud`.
5. Add both `app2.timescard.cloud` A record and TXT verification to user's DNS.

## What's already possible today vs what's missing

| Step | Today | Gap |
|---|---|---|
| Analyzer (`analyzeZip`) reads Supabase migrations + API sites | ✅ done last turn | — |
| Analyzer reads from **GitHub URL** (not just ZIP) | ❌ | Add `analyzeGitHub(owner, repo, ref)` — clones via API, feeds bytes into existing analyzer |
| Planner → apply chain (migrations → new workspace) | ✅ exists for ZIP | Needs to accept GitHub source too |
| Edge-function port (Deno → Pluto runtime) | ⚠️ manual per-function today | Add `portEdgeFunction()` transformer, tested on 10 fns |
| Frontend repo swap (env + auth shim) | ❌ no automation | Add "Frontend Bootstrap" step that writes `.env` + patches `src/integrations/supabase/client.ts` |
| Subdomain provisioning (`api.<domain>` + `<domain>`) | ⚠️ manual DNS today | Instructions surface only |
| Deploy trigger to Lovable + Pluto | ⚠️ Lovable publish is manual UI, Pluto side scriptable | Provide runbook + one-click apply where possible |

## Delivery plan

**Milestone 1 — GitHub source support** (~2h)
- `src/lib/autoconnect/github-loader.ts`: clone shallow via GitHub REST tarball, feed into existing analyzer/planner.
- UI: add "GitHub URL" tab next to "Upload ZIP" on `/dashboard/auto-connect`.
- Requires `GITHUB_API_KEY` connector (only if repo private — this one is public, so optional now).

**Milestone 2 — Live analyze + plan on `dubaiborkahouse`** (immediate)
- Run analyzer on cloned repo, verify 28 tables + 10 edge fns detected.
- Auto-generate migration plan targeting new Pluto workspace.

**Milestone 3 — Apply DB migrations** (~1h)
- Create new Pluto workspace `dubaiborkahouse`.
- Execute the 28 migrations in order, capture errors, retry idempotently.
- Verify RLS policies match.

**Milestone 4 — Port edge functions** (~3–4h; 10 functions, provider secrets needed)
- User must provide: Resend API key, WhatsApp Business token, Google Merchant creds, OpenAI key (whichever the functions call).
- Each function ported + smoke-tested via `invoke-server-function`.

**Milestone 5 — Frontend swap + publish** (~1h)
- Bootstrap script rewrites `.env` and auth imports.
- Publish frontend; user connects `app2.timescard.cloud` A record + TXT in DNS.

**Milestone 6 — Backend subdomain** (~30min + DNS wait)
- Assign backend to `api.app2.timescard.cloud`, output DNS record for user.
- Wait for propagation, verify SSL.

## What I need from you before starting

1. **`GITHUB_API_KEY` connector** — recommended even for public repos (higher rate limits, and future private-repo support). One-click link.
2. **Provider secrets for the 10 edge functions** — I'll list which each needs after Milestone 3; you paste them one by one.
3. **DNS access to `timescard.cloud`** — you'll add ~3 records when I show them (root A, `api` CNAME, `_lovable` TXT).
4. **Confirm target Pluto instance** — this project (`plutobaas.lovable.app`) is the control plane; migrated tenants land as new workspaces inside it. Correct?

## Risk / caveats (plain)

- 28 migrations may reference `auth.users` / `storage.buckets` — Pluto has equivalents but naming may differ; I'll patch on-the-fly and log every rewrite.
- Edge functions using **Lovable AI Gateway** (`LOVABLE_API_KEY`) auto-carry over. Third-party (Resend/WhatsApp) need new keys in Pluto's secret store.
- `app2.timescard.cloud` = subdomain of a domain you own. Lovable custom-domain flow supports subdomains directly; no need to move the root.
- Frontend + backend on same subdomain is not possible — they must split: `app2` = frontend, `api.app2` (or `app2-api`) = backend. Confirm you're OK with the API on `api.app2.timescard.cloud`.

## Approve to proceed

Say "go" and I'll start Milestone 1 (GitHub loader) immediately, then run Milestone 2 (live analyze on dubaiborkahouse) in the same turn. Milestones 3–6 need your secrets and DNS records as I flag them.
