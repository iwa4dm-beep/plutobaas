import type { PageHelp } from "@/lib/help/types";

export const dashboardBackupsHelp: PageHelp = {
  slug: "dashboard.backups",
  page: {
    title: { bn: "ব্যাকআপ ও রিস্টোর", en: "Backups & restore" },
    whatItDoes: {
      bn: "ডেটাবেসের স্ন্যাপশট তৈরি, ডাউনলোড এবং পূর্ববর্তী state-এ restore করার জন্য central page।",
      en: "Central page to create, download, and restore database snapshots.",
    },
    whyItMatters: {
      bn: "Human error, migration failure বা data corruption হলে recent backup ছাড়া recovery সম্ভব নয়।",
      en: "Recovery from human error, failed migrations, or corruption is impossible without recent backups.",
    },
  },
  sections: [
    {
      id: "snapshot",
      title: { bn: "Snapshot তৈরি", en: "Create a snapshot" },
      whatItDoes: { bn: "Manual snapshot নিন যখনই risky change দিতে যাচ্ছেন।", en: "Take a manual snapshot before any risky change." },
      howToUse: [
        { bn: "Create Snapshot চাপুন।", en: "Click Create Snapshot." },
        { bn: "label দিন (e.g. `pre-migration-2026-07`)।", en: "Add a label (e.g. `pre-migration-2026-07`)." },
      ],
    },
    {
      id: "restore",
      title: { bn: "Restore করা", en: "Restore a snapshot" },
      whatItDoes: {
        bn: "কোনো snapshot বেছে নিয়ে Restore চাপলে ডেটাবেস ঐ point-in-time state-এ ফেরত যাবে।",
        en: "Pick a snapshot and click Restore to roll the database back to that point-in-time.",
      },
      howToUse: [
        { bn: "Snapshot লিস্ট থেকে target row বেছে নিন।", en: "Select the target row from the snapshot list." },
        { bn: "Restore চাপুন এবং confirmation দিন।", en: "Click Restore and confirm." },
      ],
      troubleshooting: [
        {
          problem: { bn: "Restore-এর পর app বন্ধ", en: "App broken after restore" },
          solution: {
            bn: "Migration mismatch হতে পারে — Migrations page থেকে current state-এ align করুন।",
            en: "Likely a migration mismatch — re-align via the Migrations page.",
          },
        },
      ],
    },
    {
      id: "schedule",
      title: { bn: "স্বয়ংক্রিয় সময়সূচী", en: "Automated schedule" },
      whatItDoes: {
        bn: "প্রতিদিনের auto-snapshot চালু আছে; retention window plan অনুযায়ী নির্ধারিত।",
        en: "Daily auto-snapshots run automatically; retention window depends on plan.",
      },
    },
  ],
};
