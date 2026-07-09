import type { PageHelp } from "@/lib/help/types";

// /dashboard/database — main database console: tables, rows, schema browse.
export const dashboardDatabaseHelp: PageHelp = {
  slug: "dashboard.database",
  page: {
    title: { bn: "Database — টেবিল ও রো ম্যানেজমেন্ট", en: "Database — tables & rows" },
    whatItDoes: {
      bn: "এই পেইজ থেকে workspace-এর প্রতিটা টেবিল ব্রাউজ করা, row দেখা/edit/insert/delete করা, column structure দেখা, এবং CSV/JSON export-import করা যায়।",
      en: "Browse every table in the workspace, view/edit/insert/delete rows, inspect columns, and export/import CSV or JSON.",
    },
    whyItMatters: {
      bn: "Production data-এ দ্রুত এক নজরে দেখা, কোনো ভুল row ঠিক করা, বা QA-এর জন্য seed data ঢোকানোর সবচেয়ে সহজ জায়গা — SQL লেখা ছাড়াই।",
      en: "The fastest way to inspect production data, patch a bad row, or seed QA data — without writing SQL.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "বামে টেবিল লিস্ট, ডানে সিলেক্টেড টেবিলের row grid। উপরে schema selector, search box, এবং Insert/Export/Import বাটন।",
        en: "Table list on the left, row grid for the selected table on the right, with schema selector, search box, and Insert/Export/Import buttons on top.",
      },
    },
    {
      id: "browse",
      title: { bn: "কীভাবে টেবিল ব্রাউজ করবেন", en: "How to browse tables" },
      whatItDoes: {
        bn: "যেকোন টেবিল ক্লিক করলে ডানে প্রথম ৫০টা row এবং পুরো column definition দেখাবে। Pagination, sort, filter ব্যবহার করে বড় টেবিলেও নেভিগেট করা যায়।",
        en: "Clicking a table shows the first 50 rows plus full column definitions. Pagination, sort, and filter let you navigate large tables.",
      },
      howToUse: [
        { bn: "ধাপ ১: বাম প্যানেল থেকে schema (public/auth/storage ইত্যাদি) বাছাই করুন।", en: "Step 1: pick a schema (public/auth/storage) from the left panel." },
        { bn: "ধাপ ২: টেবিলের নামে ক্লিক করুন — ডানে rows load হবে।", en: "Step 2: click a table name — rows load on the right." },
        { bn: "ধাপ ৩: column header-এ ক্লিক করে sort করুন।", en: "Step 3: click a column header to sort." },
        { bn: "ধাপ ৪: উপরের Filter icon চেপে WHERE clause যোগ করুন (=, !=, LIKE, IN)।", en: "Step 4: use the Filter icon on top to add a WHERE clause (=, !=, LIKE, IN)." },
        { bn: "ধাপ ৫: pagination দিয়ে next 50 rows দেখুন।", en: "Step 5: paginate for the next 50 rows." },
      ],
    },
    {
      id: "edit",
      title: { bn: "Row edit/insert/delete", en: "Edit, insert, delete rows" },
      whatItDoes: {
        bn: "যেকোন cell-এ double-click করে সরাসরি value edit করা যায়। + Insert চেপে নতুন row, trash icon চেপে delete।",
        en: "Double-click any cell to edit inline. + Insert adds a new row; the trash icon deletes.",
      },
      howToUse: [
        { bn: "ধাপ ১: cell-এ double-click → নতুন value টাইপ করুন → Enter চাপুন।", en: "Step 1: double-click a cell → type the new value → press Enter." },
        { bn: "ধাপ ২: '+ Insert row' চেপে dialog খুলুন, প্রতিটা column-এর value দিন (default থাকলে skip করা যাবে)।", en: "Step 2: click '+ Insert row', fill in each column (skip defaults)." },
        { bn: "ধাপ ৩: 'Save' চাপলে backend-এ INSERT/UPDATE যাবে; error হলে ব্যাখ্যা দেখাবে।", en: "Step 3: 'Save' fires INSERT/UPDATE; failures show the exact error." },
        { bn: "ধাপ ৪: row-এর trash icon → 'Confirm delete' → row মুছে যাবে।", en: "Step 4: trash icon on a row → 'Confirm delete' removes it." },
      ],
      troubleshooting: [
        {
          problem: { bn: "Edit করলে 'permission denied' error", en: "'permission denied' when editing" },
          solution: {
            bn: "RLS policy এই role-কে UPDATE allow করেনি। /dashboard/rbac-এ policy check করুন অথবা service_role token ব্যবহার করুন।",
            en: "RLS blocks UPDATE for this role — review policies at /dashboard/rbac or use a service_role token.",
          },
        },
        {
          problem: { bn: "'foreign key violation'", en: "'foreign key violation'" },
          solution: {
            bn: "যে value দিচ্ছেন সেটা parent টেবিলে নেই — আগে parent-এ row যোগ করুন।",
            en: "The referenced value doesn't exist in the parent table — insert it there first.",
          },
        },
      ],
    },
    {
      id: "export-import",
      title: { bn: "Export ও Import", en: "Export & import" },
      whatItDoes: {
        bn: "উপরের Export বাটন থেকে current filter-এর সব row CSV/JSON হিসেবে download; Import থেকে CSV upload করে bulk insert।",
        en: "Export downloads current filtered rows as CSV/JSON; Import bulk-inserts from an uploaded CSV.",
      },
      howToUse: [
        { bn: "Export → format (CSV/JSON) বাছাই → file download শুরু হবে।", en: "Export → pick CSV/JSON → download starts." },
        { bn: "Import → CSV file drop → column mapping preview → 'Run import' চাপুন।", en: "Import → drop a CSV → preview column mapping → click 'Run import'." },
        { bn: "বড় dataset হলে /dashboard/database-import ব্যবহার করুন — chunked এবং resumable।", en: "For large datasets use /dashboard/database-import — it's chunked and resumable." },
      ],
    },
  ],
  glossary: [
    { term: "RLS", definition: { bn: "Row-Level Security — কোন user কোন row দেখতে/বদলাতে পারবে সেই policy।", en: "Row-Level Security — policies that decide who sees or edits a row." } },
    { term: "schema", definition: { bn: "Related টেবিলগুলোর namespace (public, auth, storage ইত্যাদি)।", en: "A namespace of related tables (public, auth, storage, etc.)." } },
  ],
};
