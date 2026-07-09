import type { PageHelp } from "@/lib/help/types";

// /dashboard/connect-project — Step-by-step guide to connect an existing
// PostgreSQL + React/Vite project to Pluto BaaS.
export const dashboardConnectProjectHelp: PageHelp = {
  slug: "dashboard.connect-project",
  page: {
    title: {
      bn: "নিজের প্রজেক্ট যুক্ত করুন — সম্পূর্ণ গাইড",
      en: "Connect your project — full setup guide",
    },
    whatItDoes: {
      bn: "আপনার existing PostgreSQL database এবং React/Vite frontend-কে Pluto BaaS-এর সব feature (Auth, Database, Realtime, Storage, Functions, AI, Vector, Users) সহ যুক্ত করার ধাপে ধাপে নিয়মাবলী।",
      en: "Step-by-step instructions to wire your existing PostgreSQL database and React/Vite frontend into Pluto BaaS with every feature enabled: Auth, DB, Realtime, Storage, Functions, AI, Vector, Users.",
    },
    whyItMatters: {
      bn: "সঠিক ধাপ অনুসরণ করলে ঘণ্টা খানেকের মধ্যে আপনার existing project পুরোপুরি backend-connected হয়ে যাবে — আলাদা code লিখতে হবে না।",
      en: "Following the correct order gets your existing project fully backend-connected within an hour — no re-implementation required.",
    },
  },
  sections: [
    {
      id: "prereq",
      title: { bn: "১. পূর্বশর্ত", en: "1. Prerequisites" },
      whatItDoes: {
        bn: "শুরুর আগে যা প্রয়োজন: PostgreSQL 14+ (Pluto managed অথবা BYOD), Node 18+, একটি React/Vite project, এবং Pluto workspace access।",
        en: "You need: PostgreSQL 14+ (Pluto-managed or BYOD), Node 18+, a React/Vite project, and Pluto workspace access.",
      },
    },
    {
      id: "workspace",
      title: { bn: "২. Workspace + API keys", en: "2. Workspace + API keys" },
      whatItDoes: {
        bn: "Dashboard → Workspaces থেকে একটি workspace তৈরি করুন এবং Projects & Keys পেইজ থেকে anon + service_role key কপি করুন।",
        en: "Create a workspace under Dashboard → Workspaces, then copy the anon + service_role keys from Projects & Keys.",
      },
      howToUse: [
        { bn: "Sidebar → Platform → Workspaces খুলুন।", en: "Open Sidebar → Platform → Workspaces." },
        { bn: "New workspace তৈরি করুন।", en: "Create a new workspace." },
        { bn: "Projects & Keys থেকে anon + service_role key কপি করুন।", en: "Copy the anon and service_role keys from Projects & Keys." },
      ],
    },
    {
      id: "db",
      title: { bn: "৩. Database migrate করুন", en: "3. Migrate the database" },
      whatItDoes: {
        bn: "দুইটি option: (A) Pluto managed Postgres ব্যবহার — সহজতম। (B) BYOD — নিজের Postgres-এ DATABASE_URL দিয়ে Pluto migrations চালান।",
        en: "Two options: (A) use Pluto-managed Postgres — easiest. (B) BYOD — point Pluto migrations at your own Postgres via DATABASE_URL.",
      },
      howToUse: [
        { bn: "BYOD: pg_dump দিয়ে existing schema export করুন।", en: "BYOD: export your existing schema with pg_dump." },
        { bn: "Pluto migrations চালান: `pnpm --filter api migrate`", en: "Run Pluto migrations: `pnpm --filter api migrate`" },
        { bn: "প্রতিটি table-এ RLS enable করুন এবং policy লিখুন।", en: "Enable RLS on every table and add policies." },
      ],
    },
    {
      id: "sdk",
      title: { bn: "৪. SDK install করুন", en: "4. Install the SDK" },
      whatItDoes: {
        bn: "Frontend project-এ `@pluto/js` SDK যোগ করুন এবং `.env`-এ API URL + anon key রাখুন।",
        en: "Add the `@pluto/js` SDK to your frontend and put the API URL + anon key in `.env`.",
      },
    },
    {
      id: "client",
      title: { bn: "৫. Client initialize করুন", en: "5. Initialize the client" },
      whatItDoes: {
        bn: "`src/lib/pluto.ts` তৈরি করে সেখানে `createClient()` কল করুন। সবগুলো hook/component এই client ব্যবহার করবে।",
        en: "Create `src/lib/pluto.ts` and call `createClient()` there. All hooks/components use this single client.",
      },
    },
    {
      id: "wire",
      title: { bn: "৬. Feature গুলো wire করুন", en: "6. Wire the features" },
      whatItDoes: {
        bn: "Auth, Database CRUD, Realtime subscription, Storage upload, Functions invoke, Vector search — প্রতিটির জন্য ready-to-paste snippet নিচে পাবেন।",
        en: "Auth, Database CRUD, Realtime subscriptions, Storage uploads, Function invokes, Vector search — ready-to-paste snippets below.",
      },
    },
    {
      id: "rls",
      title: { bn: "৭. RLS + Security", en: "7. RLS + Security" },
      whatItDoes: {
        bn: "প্রতিটি user-facing table-এ Row Level Security enable করুন এবং `has_role()` helper দিয়ে role-based policy লিখুন।",
        en: "Enable Row Level Security on every user-facing table and write role-based policies using the `has_role()` helper.",
      },
    },
    {
      id: "verify",
      title: { bn: "৮. Connection যাচাই", en: "8. Verify connection" },
      whatItDoes: {
        bn: "পেইজে থাকা 'Test connection' বাটন চেপে auth, db, storage endpoint ping করুন।",
        en: "Click the 'Test connection' button on this page to ping auth, db, and storage endpoints.",
      },
    },
    {
      id: "deploy",
      title: { bn: "৯. Deploy checklist", en: "9. Deploy checklist" },
      whatItDoes: {
        bn: "Production domain-কে CORS whitelist-এ যোগ করুন, API key rotate করুন, custom domain configure করুন, এবং monitoring চালু করুন।",
        en: "Add the production domain to the CORS whitelist, rotate API keys, configure a custom domain, and enable monitoring.",
      },
    },
  ],
  glossary: [
    { term: "BYOD", definition: { bn: "Bring Your Own Database — নিজের existing Postgres ব্যবহার করা।", en: "Bring Your Own Database — use your own existing Postgres." } },
    { term: "anon key", definition: { bn: "Public API key যা frontend-এ safely ব্যবহার করা যায় (RLS দ্বারা সুরক্ষিত)।", en: "Public API key safe to embed in the frontend (protected by RLS)." } },
    { term: "service_role", definition: { bn: "Full-access key — শুধু server-side ব্যবহার করুন, কখনো frontend-এ নয়।", en: "Full-access key — server-side only, never in the frontend." } },
  ],
};
