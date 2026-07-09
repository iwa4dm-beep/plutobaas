import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-schema — index and constraint management.
export const dashboardPlutoSchemaHelp: PageHelp = {
  slug: "dashboard.pluto-schema",
  page: {
    title: { bn: "Schema — Index ও Constraint ম্যানেজমেন্ট", en: "Schema — indexes & constraints" },
    whatItDoes: {
      bn: "এই পেইজ থেকে প্রতিটা টেবিলের index (btree/gin/gist/hash/brin) এবং constraint (unique, check, not-null, foreign key) দেখা, যোগ, ও মুছে ফেলা যায়।",
      en: "Inspect, add, and drop indexes (btree/gin/gist/hash/brin) and constraints (unique, check, not-null, foreign key) per table.",
    },
    whyItMatters: {
      bn: "সঠিক index না থাকলে query slow হয়; সঠিক constraint না থাকলে DB-তে ভুল data ঢুকে যায়। এখান থেকে দুটোই এক জায়গায় manage হয়।",
      en: "Missing indexes = slow queries; missing constraints = bad data. This page manages both in one place.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "বামে table tree, ডানে দুই ট্যাব — 'Indexes' এবং 'Constraints'। প্রতিটাতে existing list এবং 'Add' বাটন।",
        en: "Table tree on the left; right side has two tabs — 'Indexes' and 'Constraints' — each with a list + 'Add' button.",
      },
    },
    {
      id: "add-index",
      title: { bn: "Index যোগ করা", en: "Adding an index" },
      whatItDoes: {
        bn: "কোন column-এ কোন type-এর index চাই সেটা define করে সরাসরি DB-তে CREATE INDEX চালানো হয়।",
        en: "Pick columns + index type; the page runs CREATE INDEX directly against the DB.",
      },
      howToUse: [
        { bn: "ধাপ ১: বাম tree থেকে target table বাছাই করুন।", en: "Step 1: pick the target table from the left tree." },
        { bn: "ধাপ ২: 'Indexes' tab → '+ Add index'।", en: "Step 2: 'Indexes' tab → '+ Add index'." },
        { bn: "ধাপ ৩: column বাছাই করুন এবং type নির্বাচন — সাধারণ query-র জন্য btree, JSONB/array-এর জন্য gin, geo-র জন্য gist, memory-tight হলে brin।", en: "Step 3: pick columns + type — btree for regular queries, gin for JSONB/arrays, gist for geo, brin for memory-tight cases." },
        { bn: "ধাপ ৪: partial index চাইলে WHERE clause যোগ করুন (যেমন `WHERE deleted_at IS NULL`)।", en: "Step 4: add a WHERE clause for a partial index (e.g. `WHERE deleted_at IS NULL`)." },
        { bn: "ধাপ ৫: 'Concurrently' টিক দিন যাতে prod traffic block না হয়।", en: "Step 5: tick 'Concurrently' so prod traffic isn't blocked." },
        { bn: "ধাপ ৬: 'Create' চাপুন — status live update হবে।", en: "Step 6: 'Create' — status updates live." },
      ],
      troubleshooting: [
        {
          problem: { bn: "'could not create unique index — duplicate key'", en: "'could not create unique index — duplicate key'" },
          solution: {
            bn: "টেবিলে duplicate value আছে; SQL runner-এ `SELECT col, count(*) FROM t GROUP BY col HAVING count(*) > 1` চালিয়ে dedupe করুন।", en: "Table has duplicates — dedupe first via `SELECT col, count(*) ... HAVING count(*) > 1`.",
          },
        },
      ],
    },
    {
      id: "add-constraint",
      title: { bn: "Constraint যোগ করা", en: "Adding a constraint" },
      whatItDoes: {
        bn: "চার ধরনের constraint — UNIQUE (duplicate ঠেকায়), CHECK (custom rule), NOT NULL (missing value ঠেকায়), FOREIGN KEY (relation বাঁধে)।",
        en: "Four kinds — UNIQUE (no dupes), CHECK (custom rule), NOT NULL (no missing values), FOREIGN KEY (relationships).",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Constraints' tab → '+ Add constraint'।", en: "Step 1: 'Constraints' tab → '+ Add constraint'." },
        { bn: "ধাপ ২: type বাছাই করুন।", en: "Step 2: pick type." },
        { bn: "ধাপ ৩: UNIQUE হলে column, CHECK হলে expression, FK হলে target table + column বাছাই।", en: "Step 3: UNIQUE → columns; CHECK → expression; FK → target table + column." },
        { bn: "ধাপ ৪: FK-এর জন্য ON DELETE/UPDATE behavior (CASCADE/RESTRICT/SET NULL) select করুন।", en: "Step 4: FK → pick ON DELETE/UPDATE behavior (CASCADE/RESTRICT/SET NULL)." },
        { bn: "ধাপ ৫: 'Validate now' টিক দিলে existing data-ও check হবে।", en: "Step 5: tick 'Validate now' to check existing rows too." },
      ],
    },
    {
      id: "drop",
      title: { bn: "Index/constraint drop করা", en: "Dropping index / constraint" },
      whatItDoes: {
        bn: "প্রতিটা row-এর ডানে trash icon; ক্লিক করলে confirmation dialog।",
        en: "Trash icon on each row; click for confirmation.",
      },
      howToUse: [
        { bn: "ধাপ ১: row-এর trash icon-এ click।", en: "Step 1: click the trash icon on the row." },
        { bn: "ধাপ ২: warning পড়ুন — কিছু index drop করলে query slow হবে।", en: "Step 2: read the warning — dropping some indexes will slow queries." },
        { bn: "ধাপ ৩: 'Confirm drop' চাপুন।", en: "Step 3: 'Confirm drop'." },
      ],
    },
  ],
  glossary: [
    { term: "btree", definition: { bn: "সাধারণ index, =, <, > query-র জন্য।", en: "Default index for =, <, > queries." } },
    { term: "gin", definition: { bn: "JSONB, array, full-text search-এর জন্য।", en: "Best for JSONB, arrays, and full-text search." } },
    { term: "partial index", definition: { bn: "শুধু কিছু row-এ index (WHERE clause সহ)।", en: "An index over a filtered subset of rows." } },
  ],
};
