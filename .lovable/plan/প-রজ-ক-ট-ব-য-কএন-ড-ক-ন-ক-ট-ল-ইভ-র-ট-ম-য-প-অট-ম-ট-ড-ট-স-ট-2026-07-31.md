# প্রজেক্ট ব্যাকএন্ড কানেক্ট → লাইভ: রুট ম্যাপ + অটোমেটেড টেস্ট

লক্ষ্য: একটি নতুন প্রজেক্টের ব্যাকএন্ড Pluto BaaS-এর সাথে যুক্ত করে লাইভ করা, এবং প্রতিটি ধাপ ড্যাশবোর্ড থেকেই ভেরিফাই করা।

## ধাপে ধাপে কোন পেইজ ব্যবহার করবেন

| # | ধাপ | পেইজ | ফলাফল |
|---|-----|------|--------|
| 1 | Workspace + Project তৈরি | `/dashboard/workspaces`, `/dashboard/projects` | project slug |
| 2 | গাইডেড কানেকশন (মূল ধাপ) | `/dashboard/connect-project` | URL + anon/service key, CORS, import, 8টি probe |
| 3 | API keys ও রোটেশন | `/dashboard/api`, `/dashboard/key-rotation` | publishable + secret key |
| 4 | CORS origin অনুমোদন | `/dashboard/cors` | ফ্রন্টএন্ড ডোমেইন allow-list |
| 5 | ডেটাবেজ স্কিমা/ডেটা আনা | `/dashboard/database-import` (Migrator), `/dashboard/sql` | টেবিল + ডেটা |
| 6 | Auth + RLS/RBAC | `/dashboard/rbac-templates`, `/dashboard/rbac-debug`, `/dashboard/ops/rls-debug` | নিরাপদ policy |
| 7 | Storage / Realtime / Functions | `/dashboard/storage`, `/dashboard/realtime`, `/dashboard/functions` | ফিচার চালু |
| 8 | লোকাল ডেভ (ঐচ্ছিক) | `/dashboard/local-stack` | docker-compose বান্ডল |
| 9 | ডিপ্লয় + ডোমেইন | `/dashboard/auto-deploy`, `/dashboard/custom-domains` | লাইভ সাইট |
| 10 | ভেরিফাই + মনিটর | `/dashboard/backend-status`, `/dashboard/observability`, `/dashboard/logs-explorer` | সবুজ রিপোর্ট |

## এই টার্নে আমি যা করব

1. **এনালাইসিস**: `connect-project` উইজার্ডের ৮টি probe, `database-import`, `auto-deploy` ও `custom-domains` রুটের বর্তমান কোড পড়ে কোন ধাপ আসলেই লাইভ API-তে হিট করে আর কোনটা শুধু UI — তা যাচাই।
2. **E2E টেস্ট রান**: Playwright দিয়ে লোকাল প্রিভিউতে পুরো ধাপ ১→১০ ক্লিক-থ্রু করে স্ক্রিনশট + কনসোল/নেটওয়ার্ক ক্যাপচার। কোন পেইজ 401/404/ফাঁকা স্টেট দেখাচ্ছে তা রেকর্ড।
3. **রিপোর্ট পেইজ**: `/dashboard/help/connect-roadmap` নামে একটি নতুন রুট — উপরের ১০ ধাপ চেকলিস্ট আকারে, প্রতিটির পাশে "Run check" বাটন (বিদ্যমান `connect-wizard.ts` probe গুলো পুনঃব্যবহার) ও সরাসরি লিংক।
4. **ফিক্স**: টেস্টে ধরা পড়া ভাঙা ধাপগুলো (missing route link, failing probe, sidebar gap) ঠিক করা।
5. **সারাংশ**: কোন ফিচার কাজ করছে / করছে না / কীভাবে করা উচিত — চ্যাটে টেবিল আকারে।

## টেকনিক্যাল নোট

- নতুন probe লেখা হবে না; `src/lib/pluto/connect-wizard.ts`-এর বিদ্যমান চেকগুলোই roadmap পেইজে reuse হবে।
- roadmap রুট শুধু ফ্রন্টএন্ড + বিদ্যমান server function কল, নতুন migration নেই।
- Playwright স্ক্রিপ্ট `/tmp/browser/connect-e2e/` এ থাকবে, রিপোতে কমিট হবে না।
