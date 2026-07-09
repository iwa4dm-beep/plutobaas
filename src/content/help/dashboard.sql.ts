import type { PageHelp } from "@/lib/help/types";

// /dashboard/sql — ad-hoc SQL runner with read-only and write modes.
export const dashboardSqlHelp: PageHelp = {
  slug: "dashboard.sql",
  page: {
    title: { bn: "SQL Runner — সরাসরি query চালানো", en: "SQL runner — ad-hoc queries" },
    whatItDoes: {
      bn: "এই পেইজ Pluto database-এ সরাসরি SQL query চালানোর জন্য। দুইটা mode — Read-only (default, প্রতিটা query auto-rollback হয়) এবং Write mode (explicit confirmation + admin credentials লাগে)।",
      en: "Run SQL directly against the Pluto database in two modes: Read-only (default, every query is auto-rolled-back) and Write mode (requires explicit confirmation + admin credentials).",
    },
    whyItMatters: {
      bn: "UI-তে যা করা যায় না — complex JOIN, aggregate, one-off patch — সব এখান থেকে সম্ভব। কিন্তু production DB, তাই সাবধানে।",
      en: "Things the UI can't do — complex JOINs, aggregates, one-off patches — all happen here. It's your production DB, so tread carefully.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে mode toggle (Read/Write), মাঝে SQL editor (Monaco, syntax highlight, autocomplete), নিচে result grid এবং query history sidebar।",
        en: "Mode toggle (Read/Write) up top, Monaco editor with syntax highlight + autocomplete in the middle, result grid + history sidebar below.",
      },
    },
    {
      id: "run",
      title: { bn: "Query কীভাবে চালাবেন", en: "Running a query" },
      whatItDoes: {
        bn: "Editor-এ SQL লিখে 'Run' চাপলে backend-এ যাবে; result grid-এ rows, execution time, এবং affected count দেখাবে।",
        en: "Type SQL and hit 'Run' — results, execution time, and affected count show below.",
      },
      howToUse: [
        { bn: "ধাপ ১: উপরে mode 'Read-only' আছে কিনা নিশ্চিত হন (default)।", en: "Step 1: confirm mode is 'Read-only' (default)." },
        { bn: "ধাপ ২: editor-এ query লিখুন (⌘/Ctrl+Space → autocomplete)।", en: "Step 2: write your query (⌘/Ctrl+Space for autocomplete)." },
        { bn: "ধাপ ৩: 'Run' চাপুন অথবা ⌘/Ctrl+Enter।", en: "Step 3: click 'Run' or press ⌘/Ctrl+Enter." },
        { bn: "ধাপ ৪: result grid-এ column sort/filter করুন, 'Export CSV' দিয়ে download করুন।", en: "Step 4: sort/filter columns in the grid, 'Export CSV' to download." },
        { bn: "ধাপ ৫: বাম sidebar-এ query history — reuse করতে click করুন।", en: "Step 5: reuse from the query history sidebar on the left." },
      ],
    },
    {
      id: "read-only",
      title: { bn: "Read-only mode", en: "Read-only mode" },
      whatItDoes: {
        bn: "প্রতিটা query একটা transaction-এ চলে এবং শেষে ROLLBACK হয় — SELECT-ছাড়া INSERT/UPDATE/DELETE লিখলেও DB-তে কিছুই save হবে না।",
        en: "Every query runs in a transaction and is ROLLBACK-ed — so INSERT/UPDATE/DELETE never persist here.",
      },
      whenToUse: {
        bn: "Exploration, analytics, debug, বা কোনো query 'safe' কিনা যাচাই করতে।",
        en: "Exploration, analytics, debugging, or sanity-checking a query before promoting it.",
      },
    },
    {
      id: "write",
      title: { bn: "Write mode", en: "Write mode" },
      whatItDoes: {
        bn: "Toggle switch on করলে confirmation dialog আসবে; admin password re-enter করতে হবে। এরপর query commit হয়ে DB পরিবর্তন করবে।",
        en: "Toggling it on prompts a confirmation dialog and re-asks for the admin password. Queries then commit and mutate the DB.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Write mode' toggle click → confirmation dialog।", en: "Step 1: click 'Write mode' toggle → confirmation dialog." },
        { bn: "ধাপ ২: admin password type করুন এবং 'I understand' টিক দিন।", en: "Step 2: type admin password and tick 'I understand'." },
        { bn: "ধাপ ৩: query লিখে Run — এবার commit হবে।", en: "Step 3: write query, Run — it commits now." },
        { bn: "ধাপ ৪: বড় mutation-এর আগে BEGIN...ROLLBACK দিয়ে dry-run করে নিন।", en: "Step 4: dry-run big mutations with BEGIN...ROLLBACK first." },
        { bn: "ধাপ ৫: কাজ শেষে toggle off করুন যাতে accidental write না হয়।", en: "Step 5: toggle off when done to prevent accidental writes." },
      ],
      troubleshooting: [
        {
          problem: { bn: "'permission denied for table X'", en: "'permission denied for table X'" },
          solution: {
            bn: "current role-এর GRANT নেই; upper-right role selector-এ service_role বাছাই করুন।", en: "Current role lacks GRANT — switch to service_role from the role selector top-right.",
          },
        },
        {
          problem: { bn: "Query timeout (30s)", en: "Query timeout (30s)" },
          solution: {
            bn: "EXPLAIN ANALYZE চালিয়ে slow query খুঁজুন; index যোগ করুন /dashboard/pluto-schema থেকে।", en: "Run EXPLAIN ANALYZE to find slow paths; add an index from /dashboard/pluto-schema.",
          },
        },
      ],
    },
    {
      id: "history",
      title: { bn: "Query history", en: "Query history" },
      whatItDoes: {
        bn: "গত ১০০টা successful query save হয়ে থাকে (per user)। ⭐ চেপে favorite mark, ⋯ menu থেকে rename বা delete।",
        en: "Last 100 successful queries per user are saved. Star to favorite; ⋯ menu to rename/delete.",
      },
    },
  ],
  glossary: [
    { term: "ROLLBACK", definition: { bn: "Transaction বাতিল করে সব পরিবর্তন undo করে।", en: "Undoes every change made in a transaction." } },
    { term: "EXPLAIN ANALYZE", definition: { bn: "Query কীভাবে execute হয় (plan + actual timing) দেখায়।", en: "Shows how a query executes with real timings." } },
  ],
};
