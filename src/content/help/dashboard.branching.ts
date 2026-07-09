import type { PageHelp } from "@/lib/help/types";

export const dashboardBranchingHelp: PageHelp = {
  slug: "dashboard.branching",
  page: {
    title: { bn: "Branching ও Studio", en: "Branching & Studio" },
    whatItDoes: {
      bn: "Schema change-গুলো isolated branch-এ পরীক্ষা করে main-এ merge করুন, এবং একটি guided visual editor দিয়ে tables/columns/indexes/relations তৈরি করুন।",
      en: "Test schema changes on isolated branches before merging to main, and use a guided visual editor to build tables/columns/indexes/relations.",
    },
    whyItMatters: {
      bn: "Direct production schema edit risky — branching দিয়ে safely iterate করা যায়।",
      en: "Editing production schema directly is risky; branching lets you iterate safely.",
    },
  },
  sections: [
    {
      id: "create-branch",
      title: { bn: "Branch তৈরি", en: "Create a branch" },
      whatItDoes: { bn: "main থেকে fork করে একটি নতুন branch তৈরি করুন।", en: "Fork main into a new branch." },
      howToUse: [
        { bn: "New Branch চাপুন এবং একটি নাম দিন।", en: "Click New Branch and give it a name." },
        { bn: "Branch তৈরি হলে সেটির context-এ Studio ব্যবহার করুন।", en: "Once created, use Studio inside that branch's context." },
      ],
    },
    {
      id: "studio",
      title: { bn: "Visual schema editor", en: "Visual schema editor" },
      whatItDoes: {
        bn: "Table, column, index এবং foreign-key relation graphical UI-এ তৈরি ও edit করুন।",
        en: "Create and edit tables, columns, indexes, and foreign-key relations from a graphical UI.",
      },
    },
    {
      id: "merge",
      title: { bn: "Main-এ merge", en: "Merge to main" },
      whatItDoes: {
        bn: "Branch থেকে migration diff generate করে review-এর পর main branch-এ apply হয়।",
        en: "A migration diff is generated from the branch and applied to main after review.",
      },
    },
  ],
};
