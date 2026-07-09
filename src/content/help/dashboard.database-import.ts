import type { PageHelp } from "@/lib/help/types";

// /dashboard/database-import — connect external DBs, bulk import, migrations.
export const dashboardDatabaseImportHelp: PageHelp = {
  slug: "dashboard.database-import",
  page: {
    title: { bn: "Database Import & Connect", en: "Database import & connect" },
    whatItDoes: {
      bn: "এই পেইজ থেকে external database (Postgres, MySQL, MongoDB, CSV/JSON file, Supabase dump) থেকে data import করা যায়, অথবা একটা read-only connection যোগ করে সরাসরি query করা যায়।",
      en: "Import data from external databases (Postgres, MySQL, MongoDB, CSV/JSON, Supabase dump) or add a read-only connection to query them live.",
    },
    whyItMatters: {
      bn: "পুরনো system থেকে migrate করার সময় বা legacy DB-এর data নিয়ে কাজ করার সময় এটাই এক-জায়গায় সব import টুল।",
      en: "When migrating from an old system or joining legacy data, this is your one-stop import tool.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "তিনটা মূল ট্যাব — 'Import file' (CSV/JSON/SQL dump upload), 'Connect DB' (external DB credentials), 'Migrate from Supabase' (URL + service key দিয়ে সরাসরি copy)।",
        en: "Three tabs — 'Import file' (upload CSV/JSON/SQL dump), 'Connect DB' (external DB credentials), 'Migrate from Supabase' (URL + service key copy).",
      },
    },
    {
      id: "import-file",
      title: { bn: "File থেকে import", en: "Import from file" },
      whatItDoes: {
        bn: "CSV, JSON, বা SQL dump upload করে target table-এ bulk insert করে। বড় file chunk-এ ভাঙে এবং resume সাপোর্ট করে।",
        en: "Uploads a CSV, JSON, or SQL dump and bulk-inserts into a target table. Large files are chunked and resumable.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Import file' tab-এ যান।", en: "Step 1: open the 'Import file' tab." },
        { bn: "ধাপ ২: file drag-drop অথবা 'Choose file' চেপে select করুন।", en: "Step 2: drag-drop or 'Choose file'." },
        { bn: "ধাপ ৩: Target table বাছাই করুন (নতুন হলে 'Create table from headers' টিক দিন)।", en: "Step 3: pick target table (tick 'Create table from headers' for new tables)." },
        { bn: "ধাপ ৪: Column mapping preview করে ভুল column ঠিক করুন।", en: "Step 4: preview the column mapping and fix any mismatches." },
        { bn: "ধাপ ৫: 'Start import' চাপুন — progress bar চলবে, cancel/resume করা যাবে।", en: "Step 5: hit 'Start import' — progress bar shows, cancel/resume anytime." },
        { bn: "ধাপ ৬: শেষে summary দেখাবে (inserted / skipped / failed rows)।", en: "Step 6: summary shows inserted / skipped / failed rows." },
      ],
      troubleshooting: [
        {
          problem: { bn: "'invalid input syntax for type ...' error", en: "'invalid input syntax for type ...'" },
          solution: {
            bn: "CSV-এর column type target column-এর সাথে match করছে না; column mapping-এ type override করুন অথবা CSV clean করুন।",
            en: "CSV column type doesn't match target — override in column mapping or clean the CSV.",
          },
        },
      ],
    },
    {
      id: "connect-db",
      title: { bn: "External DB connect", en: "Connect an external DB" },
      whatItDoes: {
        bn: "External Postgres/MySQL/MongoDB-এর credentials save করে read-only foreign wrapper তৈরি করে — Pluto SQL runner থেকে সরাসরি query করা যাবে।",
        en: "Saves external Postgres/MySQL/MongoDB credentials, creates a read-only foreign data wrapper — queryable from Pluto's SQL runner.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Connect DB' tab → engine type বাছাই করুন।", en: "Step 1: 'Connect DB' tab → pick engine type." },
        { bn: "ধাপ ২: host, port, database, user, password লিখুন (secret manager-এ encrypt হয়ে save হবে)।", en: "Step 2: enter host, port, database, user, password (encrypted in secret manager)." },
        { bn: "ধাপ ৩: 'Test connection' চাপুন — 'Connected' দেখালে 'Save' চাপুন।", en: "Step 3: 'Test connection' — save when it says 'Connected'." },
        { bn: "ধাপ ৪: SQL runner-এ `SELECT * FROM external.<schema>.<table>` চালিয়ে দেখুন।", en: "Step 4: try `SELECT * FROM external.<schema>.<table>` in the SQL runner." },
      ],
    },
    {
      id: "migrate-supabase",
      title: { bn: "Supabase থেকে migrate", en: "Migrate from Supabase" },
      whatItDoes: {
        bn: "Supabase project URL এবং service_role key দিলে schema + data + storage bucket একসাথে copy করে।",
        en: "Given a Supabase URL + service_role key, copies schema, data, and storage buckets in one shot.",
      },
      howToUse: [
        { bn: "ধাপ ১: Supabase dashboard → Settings → API → Project URL এবং service_role secret copy করুন।", en: "Step 1: copy Project URL + service_role secret from Supabase → Settings → API." },
        { bn: "ধাপ ২: এখানে paste করে 'Preview' চাপুন — copy হবে এমন table/bucket list দেখাবে।", en: "Step 2: paste here, click 'Preview' to see what will be copied." },
        { bn: "ধাপ ৩: কোনটা skip করবেন সেটা টিক তুলে দিন।", en: "Step 3: uncheck anything you don't want copied." },
        { bn: "ধাপ ৪: 'Start migration' চাপুন — background job চলবে, /dashboard/migrations-এ progress দেখা যাবে।", en: "Step 4: 'Start migration' runs as a background job — track progress at /dashboard/migrations." },
      ],
    },
  ],
  glossary: [
    { term: "foreign data wrapper", definition: { bn: "Postgres extension যা external DB-কে local table-এর মতো query করতে দেয়।", en: "Postgres extension that lets you query an external DB like a local table." } },
    { term: "chunk", definition: { bn: "বড় file-এর ছোট অংশ যা একবারে upload হয়।", en: "A small slice of a large file uploaded at a time." } },
  ],
};
