import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-studio — spreadsheet-like data studio.
export const dashboardPlutoStudioHelp: PageHelp = {
  slug: "dashboard.pluto-studio",
  page: {
    title: { bn: "Data Studio — spreadsheet-style ডেটা এডিটিং", en: "Data Studio — spreadsheet-style editing" },
    whatItDoes: {
      bn: "Excel/Google Sheets-এর মতো grid interface-এ table edit করার জায়গা — copy-paste, multi-cell select, formula-style bulk update, inline join preview সব সাপোর্ট করে।",
      en: "An Excel/Sheets-style grid for editing tables — copy-paste, multi-select, formula-style bulk update, and inline join preview.",
    },
    whyItMatters: {
      bn: "একের পর এক row edit না করে অনেক row একসাথে বদলাতে চাইলে, বা spreadsheet থেকে data copy-paste করতে চাইলে — এটাই দ্রুততম উপায়।",
      en: "The fastest way to bulk-edit many rows or copy-paste from a spreadsheet without row-by-row clicking.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে table selector, নিচে full-screen grid। Ctrl/Shift+click দিয়ে multi-select, Ctrl+C/V দিয়ে copy-paste।",
        en: "Table selector on top, full-screen grid below. Ctrl/Shift+click to multi-select, Ctrl+C/V to copy-paste.",
      },
    },
    {
      id: "workflow",
      title: { bn: "ধাপে ধাপে workflow", en: "Step-by-step workflow" },
      whatItDoes: {
        bn: "সাধারণ bulk-edit-এর সেরা flow।",
        en: "The recommended flow for a bulk edit.",
      },
      howToUse: [
        { bn: "ধাপ ১: উপরে table বাছাই করুন — grid load হবে (100 rows initial, scroll করলে more)।", en: "Step 1: pick a table — grid loads 100 rows initially, more on scroll." },
        { bn: "ধাপ ২: column header-এ click করে sort/filter।", en: "Step 2: click a column header to sort/filter." },
        { bn: "ধাপ ৩: prod-এ পরিবর্তন এড়াতে উপরে 'Staging' toggle on রাখুন — সব change draft হিসেবে save হবে।", en: "Step 3: keep 'Staging' toggle on so changes save as drafts (safe for prod)." },
        { bn: "ধাপ ৪: cell-এ click → type → Enter (Google Sheets-এর মতো)।", en: "Step 4: click → type → Enter, like Sheets." },
        { bn: "ধাপ ৫: multiple cell select করে Ctrl+C, Excel-এ paste — বা reverse।", en: "Step 5: multi-select + Ctrl+C to paste in Excel — or the reverse." },
        { bn: "ধাপ ৬: 'Bulk update' toolbar থেকে formula দিন (যেমন `= upper(name)`) → preview → Apply।", en: "Step 6: use 'Bulk update' toolbar with a formula (e.g. `= upper(name)`) → preview → Apply." },
        { bn: "ধাপ ৭: 'Review changes' চাপুন — diff দেখাবে, তারপর 'Commit' চেপে DB-তে save।", en: "Step 7: 'Review changes' shows a diff — hit 'Commit' to persist." },
      ],
    },
    {
      id: "shortcuts",
      title: { bn: "Keyboard shortcut", en: "Keyboard shortcuts" },
      whatItDoes: {
        bn: "গতি বাড়ানোর জন্য সবচেয়ে গুরুত্বপূর্ণ shortcut।",
        en: "The most important shortcuts.",
      },
      fields: [
        { name: "Enter", purpose: { bn: "নিচের cell-এ যান / edit save করুন।", en: "Move down / save edit." } },
        { name: "Tab", purpose: { bn: "ডানের cell।", en: "Move right." } },
        { name: "Ctrl+D", purpose: { bn: "উপরের value নিচে fill।", en: "Fill down from cell above." } },
        { name: "Ctrl+Z / Y", purpose: { bn: "Undo / Redo (commit-এর আগে)।", en: "Undo / Redo before commit." } },
        { name: "Ctrl+K", purpose: { bn: "Command palette।", en: "Command palette." } },
      ],
    },
    {
      id: "joins",
      title: { bn: "Inline join preview", en: "Inline join preview" },
      whatItDoes: {
        bn: "FK column-এর পাশে chevron আইকন — click করলে referenced row expand হয়ে দেখাবে (একটা row-এ multiple related record দেখতে পাবেন)।",
        en: "A chevron next to an FK column expands the referenced row inline (see multiple related records per row).",
      },
    },
    {
      id: "safety",
      title: { bn: "সুরক্ষা", en: "Safety" },
      whatItDoes: {
        bn: "Staging mode default; commit-এর আগে সবসময় diff review করে। বড় mutation-এর জন্য confirmation লাগে।",
        en: "Staging is on by default; a diff review is required before commit; large mutations need confirmation.",
      },
      troubleshooting: [
        {
          problem: { bn: "'row not visible' — data দেখাচ্ছে না", en: "'row not visible' — data missing" },
          solution: {
            bn: "RLS filter করছে; role selector দিয়ে service_role-এ switch করুন অথবা /dashboard/rbac-এ policy দেখুন।", en: "RLS is filtering it — switch to service_role or review policies at /dashboard/rbac.",
          },
        },
      ],
    },
  ],
  glossary: [
    { term: "staging", definition: { bn: "Uncommitted draft change যা এখনো DB-তে save হয়নি।", en: "Draft changes that haven't hit the DB yet." } },
    { term: "diff", definition: { bn: "পুরনো ও নতুন value-এর পার্থক্য।", en: "Side-by-side view of old vs new values." } },
  ],
};
