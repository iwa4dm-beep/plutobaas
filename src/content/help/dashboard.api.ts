import type { PageHelp } from "@/lib/help/types";

export const dashboardApiHelp: PageHelp = {
  slug: "dashboard.api",
  page: {
    title: { bn: "REST এন্ডপয়েন্ট", en: "REST endpoints" },
    whatItDoes: {
      bn: "আপনার live SQL schema থেকে auto-generate হওয়া REST এন্ডপয়েন্টগুলো এখানে দেখানো হয়। প্রতিটি workspace-scoped টেবিলের জন্য /rest/v1/ এর নিচে একটি resource তৈরি হয়।",
      en: "Auto-generated REST endpoints derived from your live SQL schema. Each workspace-scoped table becomes a PostgREST-style resource under /rest/v1/.",
    },
    whyItMatters: {
      bn: "নতুন table বা column যোগ করলে migration চালানোর পর এখান থেকেই curl example, OpenAPI স্পেক, এবং typed TypeScript client পাওয়া যাবে — আলাদা docs লিখতে হবে না।",
      en: "After each migration, this page gives you a copy-ready curl, OpenAPI spec, and a typed TypeScript client — no separate docs to maintain.",
    },
  },
  sections: [
    {
      id: "refresh",
      title: { bn: "Schema refresh", en: "Refresh schema" },
      whatItDoes: {
        bn: "নতুন migration চালানোর পর 'Refresh' চাপুন যাতে endpoint list update হয়।",
        en: "Click 'Refresh' after running a new migration so the endpoint list picks up the change.",
      },
      howToUse: [
        { bn: "উপরে ডানদিকে Refresh বাটন চাপুন।", en: "Click Refresh at the top right." },
        { bn: "নতুন table কার্ডে appear করবে।", en: "New tables will appear as cards." },
      ],
    },
    {
      id: "typed-client",
      title: { bn: "Typed TypeScript client", en: "Typed TypeScript client" },
      whatItDoes: {
        bn: "'Typed client' চাপলে একটি .ts ফাইল download হবে যেটা আপনার schema-এর সব row/column type সহ ready-to-use client দেয়।",
        en: "'Typed client' downloads a .ts file with a ready-to-use client typed against your current schema rows and columns.",
      },
      whenToUse: {
        bn: "Frontend project-এ Pluto data fetch করতে চাইলে।",
        en: "Whenever a frontend project needs to fetch Pluto data with type safety.",
      },
    },
    {
      id: "policies",
      title: { bn: "Row-level policies", en: "Row-level policies" },
      whatItDoes: {
        bn: "প্রতিটি row-তে যে RLS policy active সেটা 🔒 icon দিয়ে দেখানো হয়। hover করলে policy expression দেখাবে।",
        en: "Active RLS policies show as a 🔒 badge on each row. Hover to see the policy expression.",
      },
      troubleshooting: [
        {
          problem: { bn: "কোন endpoint দেখাচ্ছে না", en: "No endpoints shown" },
          solution: {
            bn: "Workspace select করা আছে কিনা দেখুন এবং backend live আছে কিনা /dashboard/verify থেকে check করুন।",
            en: "Confirm a workspace is selected and the backend is reachable via /dashboard/verify.",
          },
        },
      ],
    },
  ],
  glossary: [
    { term: "PostgREST", definition: {
      bn: "PostgreSQL schema থেকে auto REST API generate করার convention — Pluto একই convention follow করে।",
      en: "Convention for generating a REST API directly from a PostgreSQL schema; Pluto follows the same shape.",
    }},
    { term: "OpenAPI", definition: {
      bn: "REST API describe করার standard JSON/YAML স্পেক।",
      en: "Standard JSON/YAML spec for describing REST APIs.",
    }},
  ],
};
