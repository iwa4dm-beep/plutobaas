import type { PageHelp } from "@/lib/help/types";

// /dashboard/migrations — schema migration history, pending runs, rollback.
export const dashboardMigrationsHelp: PageHelp = {
  slug: "dashboard.migrations",
  page: {
    title: { bn: "Database Migrations — schema version control", en: "Database migrations — schema version control" },
    whatItDoes: {
      bn: "এই পেইজ Pluto backend-এর সব SQL migration-এর version history, pending run, rollback অপশন এবং live progress দেখায়।",
      en: "Shows version history of Pluto's SQL migrations, pending runs, rollback options, and live progress.",
    },
    whyItMatters: {
      bn: "Production schema change track করা এবং কোন migration কখন apply হয়েছে/fail করেছে সেটা জানার একমাত্র official জায়গা।",
      en: "The only official place to track production schema changes and see when a migration applied or failed.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "তিনটা section — 'Applied' (successful migrations), 'Pending' (যা এখনো run হয়নি), 'Failed' (rollback candidate)।",
        en: "Three sections — 'Applied' (successful), 'Pending' (not yet run), 'Failed' (rollback candidates).",
      },
    },
    {
      id: "apply",
      title: { bn: "Migration apply করা", en: "Applying a migration" },
      whatItDoes: {
        bn: "'Pending' section-এ যেসব file দেখা যাচ্ছে সেগুলো order অনুসারে DB-তে run করবে; প্রতিটার জন্য live log stream হবে।",
        en: "Files in 'Pending' run in order; each streams a live log.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Pending' section-এ যে migration আসছে সেটার SQL preview দেখুন।", en: "Step 1: preview the SQL for the upcoming migration in 'Pending'." },
        { bn: "ধাপ ২: 'Dry-run' চাপুন — transaction-এ চলবে এবং rollback হবে; error থাকলে ধরা পড়বে।", en: "Step 2: 'Dry-run' — runs in a transaction and rolls back, exposing errors first." },
        { bn: "ধাপ ৩: dry-run pass করলে 'Apply next' চাপুন — one migration একবারে যায়।", en: "Step 3: on pass, click 'Apply next' — one migration at a time." },
        { bn: "ধাপ ৪: log stream দেখুন; 'Applied ✓' badge এলে পরের migration-এ যান।", en: "Step 4: watch the log stream; go to the next migration when badge shows 'Applied ✓'." },
        { bn: "ধাপ ৫: সব pending শেষ হলে /dashboard/verify চালিয়ে backend health confirm করুন।", en: "Step 5: once all pending are done, run /dashboard/verify to confirm health." },
      ],
      troubleshooting: [
        {
          problem: { bn: "Migration middle-এ fail করেছে", en: "Migration failed midway" },
          solution: {
            bn: "Transaction wrap থাকলে auto-rollback হয়েছে; না হলে 'Rollback to previous' চাপুন। Fix করে migration file পাঠিয়ে redeploy করুন।", en: "If wrapped in a transaction it auto-rolled back; otherwise click 'Rollback to previous'. Fix and redeploy.",
          },
        },
      ],
    },
    {
      id: "rollback",
      title: { bn: "Rollback", en: "Rollback" },
      whatItDoes: {
        bn: "'Applied' list-এর যেকোন version-এ down-migration থাকলে 'Rollback to here' দেখাবে; সেটা চাপলে সব উপরের migration reverse-order-এ undo হবে।",
        en: "Any 'Applied' entry with a down-migration shows 'Rollback to here'; clicking undoes everything above it in reverse order.",
      },
      howToUse: [
        { bn: "ধাপ ১: target version-এর row-এ 'Rollback to here' চাপুন।", en: "Step 1: click 'Rollback to here' on the target version." },
        { bn: "ধাপ ২: warning পড়ুন — data loss হতে পারে।", en: "Step 2: read the warning — this may lose data." },
        { bn: "ধাপ ৩: admin password re-enter করুন।", en: "Step 3: re-enter admin password." },
        { bn: "ধাপ ৪: 'Start rollback' → live log।", en: "Step 4: 'Start rollback' → live log." },
        { bn: "ধাপ ৫: শেষে /dashboard/verify চালান।", en: "Step 5: run /dashboard/verify afterward." },
      ],
    },
    {
      id: "boot",
      title: { bn: "Boot-time auto-migrate", en: "Boot-time auto-migrate" },
      whatItDoes: {
        bn: "Backend boot-এর সময় pending migration auto-apply করে। এই পেইজ-এ 'Last boot' badge দেখাবে শেষ boot-এ কী apply হয়েছে।",
        en: "The backend auto-applies pending migrations on boot; the 'Last boot' badge shows what ran last time.",
      },
    },
  ],
  glossary: [
    { term: "down-migration", definition: { bn: "একটা migration undo করার SQL।", en: "SQL that undoes a migration." } },
    { term: "dry-run", definition: { bn: "Rollback-এর মধ্যে run করে দেখা query safe কিনা।", en: "Runs inside a rolled-back transaction to check safety." } },
  ],
};
