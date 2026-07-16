# সাবডোমেইন হোস্টিং + অটো-ব্যাকেন্ড অ্যাটাচ — অডিট ও প্ল্যান

লক্ষ্য: `lovable.dev` / `vercel.com`-এর মতো প্রতিটি নতুন প্রজেক্ট নিজস্ব `<slug>.app.timescard.cloud` (এবং কাস্টম ডোমেইন) সাবডোমেইনে সার্ভ হবে, এবং Lovable Cloud-এর মতো ব্যাকেন্ড (DB/Auth/Storage/Functions) এক ক্লিকে অ্যাটাচ হবে।

---

## এখন কী আছে (Audit — ✅ Present)

**Hosting/Deploy পাইপলাইন**
- `pluto-backend/sandbox-worker/` — ZIP আপলোড → unzip → `/var/lib/pluto/sites/<workspaceId>/current/` → nginx সার্ভ (atomic symlink flip, last-5 releases retained, `/healthz`, `/status/:ws`, shared-secret protected)
- `nginx-app.conf` — একটি হার্ডকোডেড `<WORKSPACE_ID>` টেমপ্লেট, SPA fallback (`try_files ... /index.html`), asset caching
- `deploy/install-nginx-site.sh` — এক-ডোমেইন করে nginx site ইনস্টল + certbot
- `dashboard.pluto-deploy.tsx`, `deployment-history`, `deployment-compare` — bundle upload/deploy UI
- Custom domains — `dashboard.custom-domains.tsx` + backend migrations (`0060_phase64_domain_wildcards`, `0061_phase65_domain_admins`) — per-workspace domain, primary flag, webhook, wildcard support, admins

**Backend (Pluto/Lovable-Cloud-alike)**
- Full Pluto stack: Postgres + Auth + Storage(S3/MinIO) + Realtime + Edge Functions + Vector — migrations 0001–0033
- Workspace provisioner (`workspace-provisioner.functions.ts`) — নতুন workspace-এ schema/keys তৈরি করে
- Multi-tenant JWT (`PLUTO_JWT_SECRET`), anon/service keys per workspace
- Auto-Connect Studio (analyzer/planner/rewriter/bundler) — external repo import পর্যন্ত

**Ops**
- `deploy.sh --check` (drafted), env sync `docker/.env ↔ repo-root .env`
- API healthz, sandbox healthz, VPS health probes

---

## যা এখনো নেই / দুর্বল (Gaps — ❌ / ⚠️)

### 1. Wildcard subdomain routing (`*.app.timescard.cloud`)
- ❌ nginx টেমপ্লেট **এক workspace = এক নতুন site file**; slug → workspaceId ম্যাপ নেই
- ❌ Wildcard DNS (`*.app.timescard.cloud A → VPS IP`) সেট করার গাইড নেই
- ❌ Wildcard TLS (Let's Encrypt DNS-01 via Cloudflare/Hostinger) automation নেই
- ❌ `Host` হেডার → workspace/slug রুটিং লজিক (dynamic nginx `map` বা Caddy on-demand) নেই

### 2. Slug/Project registry
- ⚠️ `workspaces` টেবিল আছে কিন্তু public-facing `slug` (URL segment) কলাম/ইনডেক্স নেই
- ❌ Slug ইউনিকনেস + reserved-words guard + rename history নেই
- ❌ `slug → sites_root path` resolver API নেই (worker এখনো workspaceId নেয়)

### 3. Auto backend attach (Lovable Cloud parity)
- ⚠️ Provisioner আছে, কিন্তু **নতুন প্রজেক্ট create → auto-provision DB schema + issue anon/service keys + inject env** end-to-end wired নেই
- ❌ Deploy bundle-এ `PLUTO_URL` / `PLUTO_ANON_KEY` runtime injection (build-time `.env` বা `window.__PLUTO__`) নেই
- ❌ Per-project secret vault (encrypted at rest, revealed to owner only) নেই
- ❌ "Attach existing DB" vs "Fresh Cloud" chooser UI নেই

### 4. Custom domain attach (per-project)
- ⚠️ `custom_domains` টেবিল আছে, কিন্তু sandbox-worker/nginx-এ live wire-up নেই (verify → issue cert → add server block → reload) automation অসম্পূর্ণ
- ❌ Domain verification webhook → nginx reconcile loop নেই

### 5. Preview vs Production
- ❌ Lovable-এর মতো `<slug>-dev.app.timescard.cloud` (preview) বনাম `<slug>.app.timescard.cloud` (published) split নেই — worker-এ `release-*` আছে কিন্তু "publish" gate নেই

### 6. Observability & limits
- ⚠️ Per-project request logs / bandwidth / storage quota নেই
- ❌ Abuse/rate-limit per subdomain নেই

---

## প্রস্তাবিত ফেজ প্ল্যান (Phased Roadmap)

### Phase A — Wildcard Subdomain Hosting (foundation)
A1. DNS: `*.app.timescard.cloud A → VPS_IP` (Hostinger) — user manual step + docs
A2. Wildcard TLS: `certbot certonly --dns-cloudflare -d '*.app.timescard.cloud' -d 'app.timescard.cloud'` (বা Caddy on-demand TLS) — script
A3. Dynamic nginx: `map $host $ws_slug { ... }` OR single server_block + `root /var/lib/pluto/sites/$ws_slug/current;` + fallback 404 page
A4. Reserved slug list (`www`, `api`, `admin`, `app`, ইত্যাদি)

### Phase B — Slug Registry & Worker v2
B1. Migration: `workspaces.slug` (unique, citext, 3–40 chars, `^[a-z0-9-]+$`) + rename audit
B2. Sandbox-worker: accept `slug` (ও workspaceId fallback), `/resolve/:slug` endpoint
B3. `dashboard.projects.tsx`-এ slug edit + availability check + live preview URL
B4. Worker sites path: `/var/lib/pluto/sites/<slug>/current/` (symlink from workspaceId path for backward-compat)

### Phase C — Auto Backend Attach (Cloud parity)
C1. "Create Project" wizard: name → slug → **Attach Cloud?** (Yes = auto-provision schema + anon/service keys; No = BYO DB URL)
C2. Provisioner: per-project Postgres schema (`ws_<slug>`), RLS templates, storage bucket, function runtime slot
C3. Runtime env injection into deployed bundle: build step writes `/env.js` (`window.__PLUTO_ENV__ = {...}`) into `current/` — no rebuild needed on key rotation
C4. SDK auto-config: `@pluto/client` reads `window.__PLUTO_ENV__` first, then `import.meta.env`
C5. Secret vault UI (`dashboard.projects/<slug>/secrets`) — reveal-once, rotate, delete

### Phase D — Custom Domain Auto-Wire
D1. Domain add flow: verify TXT → issue cert (certbot/lego) → write `/etc/nginx/sites-available/<domain>.conf` (template) → reload
D2. Reconciler daemon: periodically diff `custom_domains` DB rows ↔ nginx site files (add/remove/renew)
D3. Failure surface: `last_error` already in schema — pipe into UI

### Phase E — Preview vs Production
E1. Two symlinks per project: `current` (published) + `preview` (latest)
E2. nginx: `<slug>-dev.app.timescard.cloud` → `preview/`, `<slug>.app.timescard.cloud` → `current/`
E3. "Publish" button flips preview → current atomically

### Phase F — Quotas, Logs, Abuse
F1. nginx access-log → per-slug parser → `project_usage` table (bytes, requests)
F2. Rate limit map per slug
F3. Dashboard usage panel

---

## Technical highlights (details section)

**Wildcard nginx skeleton (Phase A3):**
```nginx
map $host $ws_slug {
    default "";
    "~^(?<slug>[a-z0-9-]+)\.app\.timescard\.cloud$" $slug;
}
server {
    listen 443 ssl http2;
    server_name *.app.timescard.cloud;
    ssl_certificate     /etc/letsencrypt/live/app.timescard.cloud-wild/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.timescard.cloud-wild/privkey.pem;

    if ($ws_slug = "") { return 404; }
    root /var/lib/pluto/sites/$ws_slug/current;
    index index.html;
    location / { try_files $uri $uri/ /index.html; }
}
```

**Slug migration sketch (Phase B1):**
```sql
create extension if not exists citext;
alter table public.workspaces
  add column if not exists slug citext unique
    check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$');
create index workspaces_slug_idx on public.workspaces(slug);
```

**Runtime env injection (Phase C3):**
Worker `unpack` step writes:
```
/var/lib/pluto/sites/<slug>/current/env.js
  → window.__PLUTO_ENV__ = { url:"https://api.timescard.cloud", anonKey:"pk_..." };
```
Frontend `index.html` loads `<script src="/env.js"></script>` before app bundle.

---

## ডেলিভারেবল ধাপে ধাপে (আপনি কোন Phase আগে?)

- **A + B** = "সাবডোমেইনে নতুন প্রজেক্ট বসে" (minimum viable Vercel-clone)
- **C** = "Lovable Cloud-এর মতো অটো-ব্যাকেন্ড" (biggest UX win)
- **D** = কাস্টম ডোমেইন (customer-facing sites)
- **E, F** = polish + scale

**অনুগ্রহ করে জানান কোন Phase থেকে শুরু করবো** — আমি সেই Phase-এর সব কোড/মাইগ্রেশন/nginx/systemd/UI একসাথে ডেলিভার করবো।
