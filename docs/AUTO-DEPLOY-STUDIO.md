# Auto-Deploy Studio — 360° One-Click Import → Wire → Live

`/dashboard/auto-deploy` — একটি guided wizard যেটি একটি external project
নেয় (GitHub / Git URL / ZIP) এবং সেটাকে সম্পূর্ণ Pluto BaaS backend সহ
live করে দেয়।

## User flow

```
Source → Analyze → Plan → Bundle → Deploy → ✅ Live URL
```

তিনটি source type সমর্থিত:

| Source | Handler | Notes |
|--------|---------|-------|
| **GitHub** (`owner/repo`) | `loadRepoAsFile()` → `fetchGithubZip` server fn | Public repo সরাসরি; private repo workspace GitHub connector দিয়ে |
| **Git URL** (`https://github.com/...`) | same as above | Full URL বা `owner/repo` উভয়ই |
| **ZIP upload** | `File` → `JSZip.loadAsync()` | সর্বোচ্চ 200 MB |

## Pipeline (একই server fn — `deployAll`)

1. **ensureInfra** — service user + `deployments` bucket
2. **push-migrations** — auto-generated SQL (tables + GRANTs + RLS) apply
3. **upload-bundle** — rewritten frontend ZIP → storage
4. **verify-deploy** — migrations history check
5. **unpack-serve** — sandbox worker unpacks ZIP → nginx web-root
6. **activate-service** — bootstrap edge function register/patch
7. **health-check** — runtime + bootstrap invoke + served site probe

সব step-এর raw HTTP debug (URL, method, status, latency, response snippet)
UI-তে expandable ভাবে দেখানো হয়।

## Live URL

Successful deploy শেষে UI দেখায়:

```
https://<slug>.apps.timescard.cloud
```

`<slug>` auto-generate হয় (`<repo-name>-<6-char-random>`)।
Wildcard nginx (Phase E, `pluto-backend/deploy/nginx/wildcard-app.conf`)
এটাকে সেই মুহূর্তে TLS সহ serve করে — কোনো manual DNS/cert লাগে না।

## Custom domain (optional)

Live হওয়ার পরে "Attach custom domain" button ব্যবহার করে
`/dashboard/custom-domains` এ যেয়ে A + TXT record যোগ করলে
Phase D reconciler (`pluto-domain-reconciler.timer`, প্রতি 60s)
nginx template render + certbot issue করে দেয়।

## Files

- Page: `src/routes/dashboard.auto-deploy.tsx`
- Sidebar entry: **Getting Started → Auto-Deploy Studio**
- Reused: `autoconnect/{analyzer,zip-verify,bundler,github-loader}`,
  `pluto/vps-deployer.functions.ts::deployAll`

## Limits

- ZIP / repo tarball: 200 MB
- Slug: `[a-z0-9-]{1,40}` + random suffix
- Per-workspace deploy quota enforced by Phase F
  (`project_usage_and_quotas`) upstream — over-quota triggers 429 on
  `pushMigrations` step.
