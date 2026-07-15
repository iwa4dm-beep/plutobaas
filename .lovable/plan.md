# অডিট প্ল্যান — Auto-Connect Studio, Auto Deployment, Publish + Multi-Project Deploy

## লক্ষ্য

চারটা কোর ফিচার সত্যিই কাজ করছে কিনা end-to-end যাচাই করা, এবং multi-project deploy (custom domain + subdomain, frontend+backend, Pluto/Cloud-BaaS সহ) কতটুকু প্রস্তুত সেটা রিপোর্ট আকারে দেওয়া। কোনো নতুন ফিচার এই ধাপে যোগ হবে না — শুধু audit + gap report + fix তালিকা।

## Audit-এর ৫টা ধাপ

### ১. Static audit (কোড থেকে সত্য বের করা)

প্রতিটা এরিয়ার entry points, server functions, route guards, error paths পড়ে একটা matrix বানানো:

```text
Feature            | Route(s)                          | Server fn / API         | Status field
Auto-Connect Studio| /dashboard/auto-connect           | autoconnect/*.functions | wizard/analyze/plan/apply
Development        | /dashboard/pluto-deploy (dev tab) | vps-deployer / db-wizard| local vs remote
Auto-Development   | autoconnect e2e-runner + planner  | ai-planner + e2e-runner | analyze→plan→apply→verify
Publish            | /dashboard/pluto-deploy (publish) | vps-deployer.functions  | build→deploy→verify
Multi-Project      | /dashboard/projects + workspaces  | workspace-provisioner   | per-workspace isolation
Custom Domain      | /dashboard/custom-domains         | domain-audit / domain-test| DNS→verify→SSL
```

প্রতিটার জন্য চিহ্নিত করবো: (a) কোন handler আসলে ইম্প্লিমেন্টেড, (b) কোনটা stub/TODO, (c) কোথায় Lovable UI-দিয়ে manual step লাগবে (যেমন Lovable custom domain UI)।

### ২. Runtime audit (Playwright headless দিয়ে live preview-এ)

`localhost:8080` এ যা যা headless-এ চেক করা যায়:

- `/dashboard/auto-connect` — সব ট্যাব লোড হয়, wizard step ১ রেন্ডার হয়, ZIP আপলোড validator কাজ করে
- `/dashboard/pluto-deploy` — deploy form render, plan button, history table
- `/dashboard/projects` — multi-project switcher, per-workspace scoping
- `/dashboard/custom-domains` — add-domain flow UI, DNS check button
- `/dashboard/ci-status` — GitHub connector আছে বলে workflow list ফেচ হয় কিনা
- `/auth`, protected routes redirect

প্রতিটা page-এ: HTTP status, console errors, network 4xx/5xx capture — screenshot সহ।

### ৩. E2E suite health-check

বর্তমান e2e specs (auto-connect-permissions, role-switching, auth-cross-domain, custom-domains, sidebar-auto-connect) হেডলেসে চালিয়ে সবুজ/লাল আকারে রিপোর্ট করবো। যেগুলো fail সেগুলোর root cause (fixture missing, route rename, backend-dependent) আলাদা করবো।

### ৪. Multi-project + domain readiness gap-list

Publish + custom domain দুইটাই Lovable platform-side, তাই কোডে যা দরকার সেটা আলাদা:

- **Frontend (এই Lovable প্রজেক্ট):** `preview_ui--publish` + Lovable Settings → Domains দিয়ে root domain / subdomain কানেক্ট হয়। কোডে কিছু নেই — শুধু route resolution + SEO head ঠিক থাকা লাগে।
- **Backend (Pluto BaaS নিজের VPS-এ):** `pluto-backend/deploy/subdomains/install-all.sh` + `docs/CUSTOM-DOMAIN-SETUP.md` আছে। এটা প্রতি tenant-এ কী কী env / DNS দরকার — checklist দিবো।
- **Per-project isolation:** workspace-provisioner + `workspaces` table দিয়ে multi-tenant হয়। প্রতিটা project-এর জন্য আলাদা DB schema / RLS scope কতটুকু enforced সেটা যাচাই।

### ৫. Final report deliverables

1. `docs/AUDIT-2026-07.md` — প্রতিটা ফিচারের status (✅ works / ⚠️ partial / ❌ broken) + reason + fix suggestion।
2. Screenshot bundle `/tmp/browser/audit/*.png`।
3. Playwright run log summary।
4. Multi-project deploy runbook — "একটা নতুন প্রজেক্ট live করতে ঠিক কী কী step" (frontend Lovable publish → domain add → Pluto backend workspace provision → env wire → verify)।

## যা এই turn-এ কোড হিসেবে বদলাবে

শুধু:

- নতুন `docs/AUDIT-2026-07.md`
- দরকার হলে ভাঙা import / obvious bug fix (audit-এ ধরা পড়লে)

**নতুন ফিচার / বড় refactor নেই।** যদি gap পাওয়া যায় সেগুলো পরের turn-এ আপনার সম্মতিতে ঠিক করবো।

## আপনার কাছ থেকে যা লাগতে পারে (optional)

- একটা sample Laravel + React ZIP — Auto-Connect Studio wizard-এ পুরো analyze→plan→apply চেইন test করার জন্য। না দিলে fixture দিয়ে যতটুকু যায় সেটাই করবো।
- একটা GitHub repo link — CI status page-এ live data দেখার জন্য (owner/repo)।
- একটা test domain (যদি Cloudflare/DNS পর্যায় live test করতে চান) — না থাকলে DNS step docs-এ শুধু runbook থাকবে।

এই তিনটা না দিলেও audit চলবে — শুধু কিছু step "documented, not live-verified" হিসেবে মার্ক থাকবে।

---

**সম্মতি পেলে ধাপ ১ থেকে শুরু করবো এবং প্রতিটা ধাপের result একসাথে final report-এ দেবো।**