import type { PageHelp } from "@/lib/help/types";

export const dashboardPlutoBranchesHelp: PageHelp = {
  slug: "dashboard.pluto-branches",
  page: {
    title: { bn: "ডেটাবেস Branches", en: "Database Branches" },
    whatItDoes: {
      bn: "Production ডেটাবেসের lightweight copy-on-write branches, যা PR-based schema/data review-এর জন্য ব্যবহৃত হয়।",
      en: "Lightweight copy-on-write branches of production data used for PR-based schema/data review.",
    },
    whyItMatters: {
      bn: "প্রতি PR-এ isolated database দিলে schema/data change safely test করা যায় production-কে ছোঁয়ালেই।",
      en: "Isolated per-PR databases let schema/data changes be tested safely without touching production.",
    },
  },
  sections: [
    {
      id: "list",
      title: { bn: "Branch তালিকা", en: "Branch list" },
      whatItDoes: { bn: "সব active branches, তাদের creator ও status দেখানো হয়।", en: "Shows all active branches with creator and status." },
    },
    {
      id: "new",
      title: { bn: "Branch তৈরি", en: "Create branch" },
      whatItDoes: { bn: "main বা অন্য branch থেকে ফর্ক করুন।", en: "Fork from main or another branch." },
      howToUse: [
        { bn: "Create Branch চাপুন।", en: "Click Create Branch." },
        { bn: "Source branch বেছে নাম দিন।", en: "Pick a source branch and name the new one." },
      ],
    },
    {
      id: "delete",
      title: { bn: "Delete branch", en: "Delete branch" },
      whatItDoes: {
        bn: "Merge হয়ে গেলে বা আর দরকার না থাকলে branch delete করে storage মুক্ত করুন।",
        en: "Delete merged or unused branches to free storage.",
      },
    },
  ],
};
