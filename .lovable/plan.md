
# Auto-Connect Studio — এক-ক্লিক প্রজেক্ট ইন্টিগ্রেশন

## লক্ষ্য
ব্যবহারকারী শুধু একটি **React + Vite + Laravel** প্রজেক্টের ZIP আপলোড করবেন। AI নিজে থেকেই:
1. সব ফাইল/ফোল্ডার স্ক্যান করবে
2. Laravel migrations → Pluto Postgres-এ কনভার্ট ও রান করবে
3. Laravel routes/controllers → Pluto REST/RPC-এ ম্যাপ করবে
4. React/Vite frontend-এর API কলগুলো Pluto endpoint-এ রিরাইট করবে
5. `.env`, Pluto client SDK, auth, storage — সব অটো ইনজেক্ট করবে
6. এক-ক্লিক deploy-ready প্যাকেজ ফেরত দিবে

কোনো ম্যানুয়াল কাজ নেই।

---

## নতুন পেইজ: `/auto-connect`

### ধাপভিত্তিক UI (Wizard, ৬টি স্টেপ)

```text
[1] Upload ZIP  →  [2] Analyze  →  [3] Review Plan
       ↓
[4] Run Migrations  →  [5] Wire APIs  →  [6] Download + Deploy
```

প্রতিটি স্টেপে লাইভ progress + লগ + রোলব্যাক বাটন।

---

## Step 1 — Upload
- Dropzone (max 200MB ZIP)
- বাদ যাবে: `node_modules`, `vendor`, `.git`, `dist`, `build`, `storage/logs`
- ZIP সার্ভারে extract → `/tmp/autoconnect/<jobId>/`

## Step 2 — AI Analyze (auto)
সার্ভার-সাইড analyzer রান করবে:

| ডিটেক্ট | সোর্স |
|---|---|
| Frontend stack | `package.json`, `vite.config.*` |
| Laravel version | `composer.json`, `artisan` |
| DB schema | `database/migrations/*.php` |
| Models & relations | `app/Models/*.php` |
| API routes | `routes/api.php`, `routes/web.php` |
| Controllers | `app/Http/Controllers/**` |
| Auth guards | `config/auth.php`, Sanctum/Passport |
| Storage disks | `config/filesystems.php` |
| Frontend API calls | `axios`/`fetch`/`useSWR`/`react-query` grep |
| ENV vars | `.env.example` |

AI (Lovable AI Gateway, `google/gemini-2.5-flash`) একটি **Integration Plan JSON** তৈরি করবে:
```json
{ "tables": [...], "endpoints": [...], "auth": {...},
  "storage_buckets": [...], "frontend_rewrites": [...],
  "env_map": {...}, "risks": [...] }
```

## Step 3 — Review Plan
- টেবিলের তালিকা (কলাম, FK, RLS suggestion সহ)
- REST endpoint ম্যাপিং টেবিল (Laravel route → Pluto path)
- Frontend ফাইল diff প্রিভিউ
- ঝুঁকি/warning ব্যানার (যেমন: raw SQL, Eloquent scopes)
- ব্যবহারকারী চেকবক্সে টগল করতে পারবেন কী কী apply হবে

## Step 4 — Run Migrations (auto)
- Laravel migration PHP → Postgres SQL কনভার্টার (কলাম টাইপ ম্যাপ, timestamps, FK, indexes, soft deletes)
- Pluto migration runner-এ push (`/pluto-backend/migrations/` স্টাইলে)
- প্রতিটি টেবিলে auto-generate:
  - `GRANT` statements (public-schema rule মেনে)
  - RLS enable + owner-based policy
  - `updated_at` trigger
- ব্যর্থ হলে auto-rollback + লগ

## Step 5 — Wire APIs (auto)
- প্রতিটি Laravel Resource Controller → Pluto Data API v3 endpoint (`/rest/v3/...`)
- Custom controller method → Pluto RPC (`registerRpc`) স্কেলিটন তৈরি
- Auth: Sanctum → Pluto JWT bridge (auto middleware ইনজেক্ট)
- Storage: Laravel disks → Pluto storage buckets (create + policy)
- Frontend rewrite:
  - `axios.baseURL` → Pluto base URL
  - `import { createPlutoClient }` অটো-ইনজেক্ট
  - Auth token attach helper
  - `.env` → `VITE_PLUTO_URL`, `VITE_PLUTO_ANON_KEY`

## Step 6 — Download + Deploy
তৈরি হবে:
- `frontend-connected.zip` (রিরাইট করা Vite প্রজেক্ট)
- `pluto-migrations.zip` (SQL ফাইলগুলো)
- `INTEGRATION_REPORT.md` (কী কী হলো, কী হয়নি, next steps)
- One-command deploy স্ক্রিপ্ট (`./apply.sh`)
- "Apply to my Pluto instance" বাটন — সরাসরি বর্তমান Pluto backend-এ push

---

## Technical Design

### ফাইল স্ট্রাকচার
```text
src/routes/auto-connect.tsx              # wizard UI
src/routes/auto-connect.$jobId.tsx       # job detail / progress
src/components/autoconnect/
  UploadStep.tsx
  AnalyzeStep.tsx
  PlanReview.tsx
  MigrationsStep.tsx
  WireApiStep.tsx
  DownloadStep.tsx
  LogStream.tsx

src/lib/autoconnect/
  analyzer.functions.ts       # createServerFn: unzip + scan
  laravel-parser.server.ts    # PHP AST-light regex parser
  migration-converter.server.ts
  route-mapper.server.ts
  frontend-rewriter.server.ts
  ai-planner.functions.ts     # Lovable AI Gateway call
  job-store.server.ts         # job state (Pluto DB)

src/routes/api/public/autoconnect/
  upload.ts                   # multipart ZIP receive
  status.$jobId.ts            # SSE progress stream
```

### ডাটাবেস (Pluto তে নতুন টেবিল)
```text
autoconnect_jobs(id, user_id, status, plan_json, report_json, created_at)
autoconnect_artifacts(id, job_id, kind, path, size)
autoconnect_logs(id, job_id, ts, level, message)
```
সব টেবিলে RLS: `user_id = auth.uid()`, `GRANT` authenticated রোলে।

### AI Prompt Strategy
- **Zod schema-constrained** structured output (`Output.object`)
- Schema-এ কোনো `.min()`/`.max()` নেই (gateway rule)
- Length/limit prompt-এ, validate কোডে
- Model: `google/gemini-2.5-flash` (দ্রুত + বড় context)
- Fallback: `NoObjectGeneratedError` হলে `error.text` parse

### Laravel → Pluto ম্যাপিং রুলস
| Laravel | Pluto |
|---|---|
| `$table->id()` | `id uuid PK default gen_random_uuid()` |
| `$table->string('x')` | `x text` |
| `$table->foreignId('user_id')` | `user_id uuid REFERENCES users(id)` |
| `Route::apiResource('posts', ...)` | `/rest/v3/posts` CRUD |
| `Auth::user()` | Pluto JWT → `auth.uid()` |
| `Storage::disk('s3')` | Pluto bucket + signed URLs |
| Sanctum token | Pluto refresh_token flow |

### সিকিউরিটি
- ZIP bomb protection (max uncompressed 2GB, max files 20k)
- Path traversal check (extracted paths must stay in job dir)
- PHP execution **কখনো নয়** — শুধু static parse
- Job আইসোলেশন per-user (RLS)
- Rate limit: 3 job/user/hour

### প্রগ্রেস স্ট্রিম
Server route `/api/public/autoconnect/status/$jobId` → SSE
Frontend `EventSource` দিয়ে লাইভ লগ + percentage

---

## ডেলিভারেবল চেকলিস্ট
- [ ] `/auto-connect` route + 6-step wizard UI
- [ ] ZIP upload + safe extraction
- [ ] Laravel static analyzer (migrations, routes, models, controllers)
- [ ] AI planner (Lovable AI Gateway, structured output)
- [ ] Migration converter (PHP → Postgres SQL + RLS + GRANT)
- [ ] Route mapper (Laravel → Pluto REST/RPC)
- [ ] Frontend rewriter (axios/fetch → Pluto client)
- [ ] Job persistence (3 নতুন টেবিল + migration)
- [ ] SSE live progress
- [ ] Download bundle (frontend zip + migrations zip + report)
- [ ] "Apply to Pluto" one-click deploy
- [ ] বাংলা + ইংরেজি UI টেক্সট
- [ ] Error boundary + rollback প্রতি স্টেপে

---

## স্কোপের বাইরে (Phase 2)
- Vue/Angular frontend সাপোর্ট
- Laravel Livewire/Inertia SSR
- Complex raw SQL migration
- Custom middleware auto-porting
- WebSocket/Broadcasting mapping

---

## আনুমানিক সাইজ
- ~15 নতুন ফাইল
- ~1 migration (3 টেবিল)
- ~2500-3000 লাইন কোড
- Lovable AI Gateway + Pluto DB ব্যবহার হবে (কোনো নতুন secret লাগবে না)

প্ল্যান approve করলে ধাপে ধাপে বিল্ড শুরু করবো — প্রথমে UI shell + upload + analyzer, তারপর AI planner, এরপর converters ও rewriter, শেষে download + deploy।
