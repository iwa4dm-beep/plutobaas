import type { PageHelp } from "@/lib/help/types";

// /dashboard/jobs — pool user & job tokens for BYPASSRLS server workers.
export const dashboardJobsHelp: PageHelp = {
  slug: "dashboard.jobs",
  page: {
    title: { bn: "Jobs — pool user ও job token", en: "Jobs — pool user & job tokens" },
    whatItDoes: {
      bn: "Server-side worker যেগুলো `pluto_jobs` Postgres role (BYPASSRLS) হিসেবে চলে, তাদের জন্য scoped, expiring token mint/rotate/revoke করা যায়। Service-role key share না করে narrow permission দেওয়া যায়।",
      en: "Mint/rotate/revoke scoped, expiring tokens for server workers that run as the dedicated `pluto_jobs` Postgres role (BYPASSRLS) — narrow permissions without sharing the service-role key.",
    },
    whyItMatters: {
      bn: "Background worker (queue consumer, ETL, cleanup) RLS bypass করতে হয় ঠিক আছে, কিন্তু ওদেরকে full service_role দেওয়া মানে leak হলে পুরো database compromised। Job token blast-radius সীমিত রাখে।",
      en: "Background workers (queue consumers, ETL, cleanup) legitimately bypass RLS, but handing them full service_role means a leak compromises everything. Job tokens shrink the blast radius.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে '+ Mint job token', নিচে existing token list (name, scope, last-used, expiry) এবং Rotate/Revoke বাটন।",
        en: "Top: '+ Mint job token'. Below: token list (name, scope, last-used, expiry) with Rotate/Revoke.",
      },
    },
    {
      id: "mint",
      title: { bn: "Job token mint", en: "Mint a job token" },
      howToUse: [
        { bn: "ধাপ ১: '+ Mint job token' → worker-এর নাম (`queue-consumer-prod`)।", en: "Step 1: '+ Mint job token' → worker name (`queue-consumer-prod`)." },
        { bn: "ধাপ ২: scope বাছাই (schema/table subset যেখানে বৈধ)।", en: "Step 2: pick scope (schema/table subset it's valid on)." },
        { bn: "ধাপ ৩: expiry — production job-এর জন্য 30-90 দিন recommend।", en: "Step 3: expiry — 30-90 days recommended for production jobs." },
        { bn: "ধাপ ৪: Mint → dialog-এ token → deploy secret store-এ save।", en: "Step 4: Mint → grab the token from the dialog → save to your deploy secret store." },
      ],
    },
    {
      id: "rotate-revoke",
      title: { bn: "Rotate ও Revoke", en: "Rotate & Revoke" },
      howToUse: [
        { bn: "ধাপ ১: rotate → নতুন token, পুরনোটা expire; deploy pipeline update করুন।", en: "Step 1: rotate → mints a new token and expires the old one; update the deploy pipeline." },
        { bn: "ধাপ ২: leak সন্দেহ → সাথে সাথে Revoke (irreversible)।", en: "Step 2: suspected leak → Revoke immediately (irreversible)." },
      ],
      troubleshooting: [
        { problem: { bn: "Worker 401 দিচ্ছে rotation-এর পর", en: "Worker returns 401 after rotation" }, solution: { bn: "Deploy-এ নতুন token roll করা হয়নি — env var update করে restart করুন।", en: "The new token isn't rolled to the deploy — update the env var and restart." } },
        { problem: { bn: "Query permission-denied", en: "Query gets permission-denied" }, solution: { bn: "Scope-এ ঐ table নেই — token scope বাড়ান বা `pluto_jobs` role-এ GRANT করুন।", en: "That table isn't in the scope — widen the scope or GRANT to the `pluto_jobs` role." } },
      ],
    },
  ],
  glossary: [
    { term: "pluto_jobs", definition: { bn: "BYPASSRLS Postgres role যা background worker use করে।", en: "The BYPASSRLS Postgres role used by background workers." } },
    { term: "BYPASSRLS", definition: { bn: "Row Level Security ignore করে run করার privilege।", en: "Privilege to run ignoring Row Level Security." } },
  ],
};
