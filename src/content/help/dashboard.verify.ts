import type { PageHelp } from "@/lib/help/types";

// /dashboard/verify — end-to-end backend verification checklist.
export const dashboardVerifyHelp: PageHelp = {
  slug: "dashboard.verify",
  page: {
    title: {
      bn: "Live Checklist — ব্যাকএন্ড ভেরিফিকেশন",
      en: "Live checklist — backend verification",
    },
    whatItDoes: {
      bn: "এই পেইজ আপনার Pluto backend-এর ১২টা critical endpoint parallel-ভাবে ping করে দেখায় সব subsystem (DB, storage, auth, migration, realtime, ইত্যাদি) ঠিকমতো live আছে কিনা।",
      en: "Pings 12 critical Pluto endpoints in parallel to confirm every subsystem (DB, storage, auth, migrations, realtime, etc.) is live.",
    },
    whyItMatters: {
      bn: "নতুন deploy, secret rotate, বা migration-এর পর এক ক্লিকে বোঝা যাবে সব ঠিক আছে কিনা — production incident-এর আগে সমস্যা ধরা পড়ে।",
      en: "After any deploy, secret rotation, or migration, one click confirms everything is intact — you catch issues before users do.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে একটা 'Run all checks' বাটন। নিচে ১২টা row — প্রতিটাতে endpoint নাম, expected status, actual result (✔/✘/—), এবং latency দেখা যাবে।",
        en: "Top button 'Run all checks'; 12 rows below show endpoint name, expected status, actual result (✔/✘/—), and latency.",
      },
    },
    {
      id: "run-all",
      title: { bn: "সব চেক একসাথে চালানো", en: "Run all checks" },
      whatItDoes: {
        bn: "'Run all checks' চাপলে প্রতিটা probe parallel-ভাবে চলে — সাধারণত ২-৩ সেকেন্ডের মধ্যে সব result চলে আসে।",
        en: "'Run all checks' runs every probe in parallel — results usually arrive in 2–3 seconds.",
      },
      howToUse: [
        { bn: "'Run all checks' বাটন চাপুন।", en: "Click 'Run all checks'." },
        { bn: "প্রতিটি row-তে ✔ (pass), ✘ (fail), বা — (skipped) icon দেখুন।", en: "Watch each row for ✔ (pass), ✘ (fail), or — (skipped)." },
        { bn: "যেকোন failed row-এ hover করলে বিস্তারিত error message দেখাবে।", en: "Hover a failed row to see the detailed error message." },
        { bn: "ইনডিভিজুয়াল row-এর 'Run' চেপে শুধু সেটাই আবার চালানো যায়।", en: "Click 'Run' on a single row to re-run just that check." },
      ],
    },
    {
      id: "checks",
      title: { bn: "কোন কোন চেক চলে", en: "What each check does" },
      whatItDoes: {
        bn: "১২টা probe তিনটা category-তে ভাগ করা যায় — public health, authenticated data, এবং admin/service-role।",
        en: "The 12 probes fall into three categories: public health, authenticated data, and admin/service-role.",
      },
      fields: [
        { name: "/healthz", purpose: { bn: "Process বেঁচে আছে কিনা।", en: "Is the process alive?" } },
        { name: "/readyz", purpose: { bn: "DB + cache + migration ready কিনা।", en: "DB + cache + migrations ready?" } },
        { name: "/auth/v1/token", purpose: { bn: "Auth service token issue করতে পারছে কিনা।", en: "Can auth service mint tokens?" } },
        { name: "/rest/v1/", purpose: { bn: "Data API respond করছে কিনা।", en: "Is the Data API responding?" } },
        { name: "/storage/v1/bucket", purpose: { bn: "Storage bucket list করা যাচ্ছে কিনা।", en: "Can we list storage buckets?" } },
        { name: "/realtime/v1/health", purpose: { bn: "Realtime websocket up কিনা।", en: "Is realtime websocket up?" } },
        { name: "/admin/v1/migrations/last-boot", purpose: { bn: "শেষ migration successful ছিল কিনা (service role লাগে)।", en: "Was the last migration successful? (service role needed)" } },
      ],
    },
    {
      id: "service-role",
      title: { bn: "Service-role চেকসমূহ", en: "Service-role checks" },
      whatItDoes: {
        bn: "যেসব row-তে 'requires service role' লেখা, সেগুলোর জন্য service-role API key দরকার। Key না থাকলে ওই checkগুলো — icon দিয়ে skip হয়ে যাবে।",
        en: "Rows tagged 'requires service role' need a service-role API key. Without it they're skipped and show —.",
      },
      whenToUse: {
        bn: "Admin route (যেমন /admin/v1/migrations/last-boot) test করতে হলে।",
        en: "Whenever you need to hit an admin route like /admin/v1/migrations/last-boot.",
      },
      howToUse: [
        { bn: "/dashboard/api-এ গিয়ে একটা service-role key mint করুন।", en: "Mint a service-role key under /dashboard/api." },
        { bn: "উপরের 'Service role token' input-এ paste করুন।", en: "Paste it in the 'Service role token' input at the top." },
        { bn: "আবার 'Run all checks' চাপুন।", en: "Hit 'Run all checks' again." },
      ],
    },
    {
      id: "troubleshooting",
      title: { bn: "সাধারণ সমস্যা", en: "Common issues" },
      whatItDoes: {
        bn: "একাধিক check fail করলে নিচের গাইড ধাপে ধাপে দেখুন।",
        en: "When multiple checks fail at once, walk this list top-to-bottom.",
      },
      troubleshooting: [
        {
          problem: { bn: "সব check offline দেখাচ্ছে", en: "Every check shows offline" },
          solution: {
            bn: "PLUTO_UPSTREAM_URL secret set আছে কিনা check করুন; backend restart করুন (`systemctl restart pluto-backend`)।",
            en: "Confirm PLUTO_UPSTREAM_URL is set and restart the backend (`systemctl restart pluto-backend`).",
          },
        },
        {
          problem: { bn: "401 Unauthorized আসছে", en: "401 Unauthorized on admin checks" },
          solution: {
            bn: "Service-role key invalid বা expire — /dashboard/api থেকে নতুন key issue করুন।",
            en: "Service-role key is invalid or expired — issue a new one from /dashboard/api.",
          },
        },
        {
          problem: { bn: "readyz fail করছে কিন্তু healthz pass", en: "readyz fails but healthz passes" },
          solution: {
            bn: "Process বেঁচে আছে কিন্তু DB/migration আটকে আছে — /dashboard/migrations দেখুন এবং log check করুন।",
            en: "Process is alive but DB/migrations are stuck — check /dashboard/migrations and inspect logs.",
          },
        },
        {
          problem: { bn: "Latency অনেক বেশি (>2s)", en: "Latency is very high (>2s)" },
          solution: {
            bn: "VPS overloaded বা network slow — Ops → Observability-এ CPU/RAM দেখুন।",
            en: "VPS is overloaded or network is slow — check CPU/RAM in Ops → Observability.",
          },
        },
      ],
    },
  ],
  glossary: [
    { term: "readyz", definition: { bn: "Kubernetes-style readiness probe — backend request নিতে প্রস্তুত কিনা জানায়।", en: "Kubernetes-style readiness probe — tells whether the backend is ready to accept requests." } },
    { term: "healthz", definition: { bn: "Liveness probe — process বেঁচে আছে কিনা তা যাচাই করে।", en: "Liveness probe — confirms the process is alive." } },
    { term: "service role", definition: { bn: "সর্বোচ্চ privilege-এর API key, শুধু admin কাজে ব্যবহৃত হয় এবং RLS bypass করে।", en: "The highest-privilege API key — used for admin ops and bypasses RLS." } },
    { term: "probe", definition: { bn: "একটা lightweight HTTP call যা কোনো subsystem-এর অবস্থা যাচাই করে।", en: "A lightweight HTTP call that checks a subsystem's state." } },
  ],
};
