## লক্ষ্য

Chrome এক্সটেনশন + Pluto webhook দিয়ে **GitHub / Supabase / Lovable-এ আপনার লগইন করা সেশন ব্যবহার করে** পুরো প্রজেক্ট কোড ও ডাটাবেজ স্কিমা Pluto BaaS-এ এক ক্লিকে মাইগ্রেট করা — Marketplace পেজ থেকেই ইনস্টল/কনফিগার করা যাবে।

কেন এক্সটেনশন লাগে: Lovable ও Supabase ড্যাশবোর্ডের ভিতরের ডেটা (প্রজেক্ট লিস্ট, DB পাসওয়ার্ড-বিহীন স্কিমা, connection string) সার্ভার থেকে পড়া যায় না — ব্রাউজারে আপনার লগইন করা ট্যাব থেকেই পড়তে হয়। এক্সটেনশন সেটাই করবে, তারপর Pluto-র webhook-এ পাঠাবে।

```text
[Chrome Extension]                  [Pluto BaaS]
 lovable.dev tab  ─┐
 supabase.com tab ─┼─ collect ──► POST /api/public/pluto-import
 github.com tab   ─┘   (HMAC)         │
                                      ├─► repo zip fetch + unpack (sandbox worker)
                                      ├─► schema SQL → migration bundle → dry-run → apply
                                      └─► job status ◄── Marketplace UI polling
```

## যা তৈরি হবে

### ১. Chrome Extension (MV3) — `extension/`
- `manifest.json`: MV3, permissions `storage`, `tabs`, `scripting`, `cookies`; host_permissions — `*.lovable.dev`, `*.supabase.com`, `api.github.com`, `github.com`, আপনার Pluto API ডোমেইন।
- `popup.html` + `popup.js`: Pluto API URL + Import Token বসানোর ফর্ম, "Scan" বাটন (কোন কোন সোর্স ধরা পড়ল দেখাবে), "Send to Pluto" বাটন, লাইভ জব স্ট্যাটাস।
- `content-lovable.js`: খোলা Lovable ড্যাশবোর্ড থেকে project id/name/GitHub repo লিংক তুলবে।
- `content-supabase.js`: Supabase ড্যাশবোর্ড থেকে project ref, region, table/schema তথ্য (SQL editor API) তুলবে।
- `background.js`: GitHub session দিয়ে `api.github.com` থেকে repo list + default branch + zipball URL আনবে; সব একত্র করে HMAC-signed payload Pluto-তে POST করবে।
- প্যাকেজ: `public/downloads/pluto-migrator-extension.zip` (zip via nix), Marketplace পেজে fetch+blob ডাউনলোড বাটন।

### ২. Webhook / ইনজেস্ট এন্ডপয়েন্ট
- `src/routes/api/public/pluto-import.ts` — POST, HMAC `X-Pluto-Signature` (secret: `PLUTO_IMPORT_SECRET`) যাচাই, Zod ভ্যালিডেশন, রিপ্লে-প্রোটেকশন (`event.id` + TTL, বিদ্যমান idempotency প্যাটার্ন অনুসরণ)।
- payload স্কিমা: `{ event_id, source: 'lovable'|'supabase'|'github', repo?, zipball_url?, github_token_hint?, supabase: { ref, schema_sql?, tables[] }, target: { project_id, slug } }`।
- এন্ডপয়েন্ট একটি **import job** তৈরি করবে এবং সাথে সাথে `202 { job_id }` ফেরত দেবে।

### ৩. Import পাইপলাইন (server functions)
`src/lib/pluto/import-job.functions.ts`:
- `startImportJob` — repo zip ডাউনলোড → বিদ্যমান sandbox-worker `/unpack` ফ্লো-তে পাঠানো (যেটা ইতিমধ্যে কাজ করছে)।
- `translateSupabaseSchema` — Supabase স্কিমা SQL → Pluto-সঙ্গত মাইগ্রেশন: `auth.users` → Pluto users, RLS policy রূপান্তর, `IF NOT EXISTS` idempotency যোগ, storage buckets ম্যাপিং।
- `runImportMigrations` — আগে **dry-run** (বিদ্যমান db-diagnostics dry-run টুল), তারপর approve হলে apply।
- `getImportJob` — স্ট্যাটাস/লগ পোলিং।

### ৪. Marketplace পেজ ইন্টিগ্রেশন
`src/routes/dashboard.pluto-marketplace.tsx`-এ নতুন সেকশন **"Migrate from Lovable / Supabase / GitHub"**:
- এক্সটেনশন ডাউনলোড + ইনস্টল স্টেপ (chrome://extensions → Developer mode → Load unpacked)।
- Import Token জেনারেট বাটন (HMAC secret-এর সাথে বাঁধা), কপি-টু-ক্লিপবোর্ড।
- ইনকামিং import job লিস্ট: সোর্স, repo, স্ট্যাটাস, dry-run রিপোর্ট, **Apply** / **Rollback** বাটন।
- এক্সটেনশনটি রেজিস্ট্রিতে official `webhook` category extension হিসেবেও পাবলিশ হবে, যাতে বিদ্যমান install/dispatch লাইফসাইকেল কাজ করে।

## নিরাপত্তা
- কোনো GitHub/Supabase টোকেন Pluto-তে সংরক্ষণ হবে না — এক্সটেনশন ব্রাউজার সেশন ব্যবহার করে ডেটা টানে, শুধু ফলাফল পাঠায়।
- ইনজেস্ট এন্ডপয়েন্ট `/api/public/*`-এ থাকলেও প্রতিটি রিকোয়েস্টে HMAC + timing-safe compare + replay guard বাধ্যতামূলক।
- DB apply সবসময় dry-run → manual approve; prod env-এ বিদ্যমান Ops approval ওয়ার্কফ্লো ব্যবহার করবে।
- Secret `PLUTO_IMPORT_SECRET` shared secret হিসেবে আপনি নিজে তৈরি করে দুই জায়গায় (Pluto secret + এক্সটেনশন popup) বসাবেন।

## সীমাবদ্ধতা (আগে জানিয়ে রাখছি)
- Supabase-এর **ডেটা রো** (actual rows) ব্রাউজার সেশন থেকে বড় আকারে টানা অনির্ভরযোগ্য — প্রথম ধাপে schema + RLS + storage bucket structure মাইগ্রেট হবে; রো-ডেটার জন্য `pg_dump` connection string দিয়ে আলাদা ধাপ (ঐচ্ছিক, দ্বিতীয় ফেজ)।
- Lovable ড্যাশবোর্ডের DOM বদলালে content script সিলেক্টর আপডেট লাগবে — তাই একাধিক fallback সিলেক্টর ও "manual paste" ফলব্যাক থাকবে।

## ফাইল সারাংশ
- নতুন: `extension/*` (৬ ফাইল), `src/routes/api/public/pluto-import.ts`, `src/lib/pluto/import-job.functions.ts`, `src/lib/pluto/supabase-schema-translate.ts`, `src/components/pluto/MigrateImportPanel.tsx`
- সম্পাদনা: `src/routes/dashboard.pluto-marketplace.tsx`, `public/downloads/manifest.json`
