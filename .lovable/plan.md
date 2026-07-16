## Goal

তুমি বলেছো: Auto-Deploy Studio পুরো test করবো, issue fix করবো, `https://github.com/ctgpost/musafirdesk` live করবো, এবং ভবিষ্যতের যেকোনো GitHub project যাতে auto-deploy হয় সেটা নিশ্চিত করবো — সব credential/env AI নিজেই set করবে।

কাজটা বড়, তাই প্রথমে আমি সমস্যা খুঁজে বের করবো (headless browser দিয়ে সত্যিকারের deploy চালিয়ে), তারপর তালিকা ধরে fix করবো — অন্ধভাবে refactor নয়।

## Phase 1 — Diagnose (কোথায় কোথায় ভাঙে দেখা)

1. Playwright script দিয়ে `/dashboard/auto-deploy` এ যাবো, workspace select করবো, GitHub source-এ `ctgpost/musafirdesk` দিয়ে run করবো, প্রতিটা phase-এ screenshot + console + network capture করবো:
   - GitHub loader (server fn → codeload/gateway)
   - `analyzeZip` (frontend + Laravel/PHP backend detection — musafirdesk is likely Laravel/PHP)
   - `ai-deploy-planner` (LOVABLE_API_KEY দিয়ে SQL/env plan তৈরি)
   - Approval modal → env vars → `deployAll` → health check → live URL
2. প্রতিটা failure এর জন্য root cause note করবো (missing secret, wrong request shape, analyzer edge case, timeout, ইত্যাদি)।
3. Existing secrets একবারে check: DBH_VPS_*, PLUTO_* সব আছে; missing কিছু (যেমন GitHub token scope, planner model access) দেখলে সেই মুহূর্তে `add_secret`/`generate_secret`/`set_secret` call করবো। User-obtained secret লাগলে জিজ্ঞেস করবো, নয়তো auto-provision।

## Phase 2 — Fix (শুধু যা ভাঙে সেটাই)

Diagnose থেকে পাওয়া issue-গুলো টার্গেট করে fix — যেমন সাধারণত এই জায়গাগুলোতে সমস্যা হয়:

- **GitHub loader**: private/large repo, non-`main` default branch, redirect handling, gateway auth mismatch।
- **Analyzer**: musafirdesk-এর মতো Laravel repo-তে migrations/routes parse fail, `.env.example` env-key detection।
- **AI planner**: prompt খুব বড় হলে truncate, JSON parse fail, model rate-limit।
- **Env auto-fill**: `.env.example` থেকে key তুলে UI-তে prefill, sensitive key মাস্ক, Pluto-provided (SUPABASE_URL, ANON_KEY, JWT_SECRET) auto-inject।
- **deployAll pipeline**: step timeout, health-check false negative, rollback bundle-bytes cache।
- **Real-time streaming**: `stepEvents` UI update rate, stuck spinner।

প্রতিটা fix-এর পর same Playwright script re-run করে regression check।

## Phase 3 — Deploy musafirdesk

Fix-গুলো passing হলে UI থেকে সরাসরি (headless-এ automate করে) musafirdesk deploy করবো, live URL capture করে তোমাকে দেবো + screenshot।

## Phase 4 — Ensure future GitHub URLs "just work"

- `github-loader` এ default-branch discovery যোগ করবো (`main` → `master` → `HEAD` fallback ইতিমধ্যে আছে, কিন্তু API দিয়ে সঠিক branch resolve করবো)।
- Common env-var preset (Laravel `APP_KEY`, `DB_*`, Node `PORT`, ইত্যাদি) auto-generate: random হলে `generate_secret`-এর মতো client-side crypto, Pluto-issued হলে workspace থেকে auto-fill।
- Analyzer-এ Laravel/Node/Next/Vite detector শক্ত করবো যাতে unknown stack-এও একটা কাজ-করা bundle তৈরি হয়।
- Documentation snippet `docs/AUTO-DEPLOY-STUDIO.md`-এ update।

## Technical notes

- Playwright script `/tmp/browser/auto-deploy/` এ, session `LOVABLE_BROWSER_SUPABASE_*` env থেকে restore।
- Server fn call chain: `fetchGithubZip` → client `analyzeZip` → `planIntegration` (AI) → `deployAll` (VPS)।
- Secrets already available: `DBH_VPS_*`, `PLUTO_*`, `GITHUB_API_KEY`, `LOVABLE_API_KEY` — এগুলোই deploy চালাতে যথেষ্ট হওয়ার কথা; কোনো নতুন secret দরকার হলে turn-এ জানিয়ে add করবো।
- musafirdesk যেহেতু Laravel + সম্ভবত Vue/Blade — bundler এটাকে static bundle বানাতে পারবে কিনা সেটা Phase 1-এই দেখা যাবে; না পারলে সেটা biggest fix।

## Deliverables

1. Auto-Deploy Studio-র bug list + প্রতিটার fix (code diff)।
2. musafirdesk live URL।
3. Future GitHub deploy hardening (loader + analyzer + env auto-fill)।
4. Screenshots + short report।

---

**Approve করলে Phase 1 (diagnose run) শুরু করছি।** কোনো ধাপে user-only secret (যেমন musafirdesk repo যদি private হয় তাহলে extra scoped token) লাগলে তখন `add_secret` দিয়ে জিজ্ঞেস করবো — নয়তো fully auto।
