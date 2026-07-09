import type { PageHelp } from "@/lib/help/types";

export const dashboardWorkspacesHelp: PageHelp = {
  slug: "dashboard.workspaces",
  page: {
    title: { bn: "ওয়ার্কস্পেস", en: "Workspaces" },
    whatItDoes: {
      bn: "প্রতিটি workspace-এর নিজস্ব users, API keys এবং RLS-scoped data থাকে। এখানে workspace তৈরি ও ম্যানেজ করুন।",
      en: "Each workspace has its own users, API keys, and RLS-scoped data. Create and manage workspaces here.",
    },
    whyItMatters: {
      bn: "Multi-tenant বা multi-env setup-এ workspace দিয়ে data ও access পরিষ্কারভাবে আলাদা রাখা যায়।",
      en: "Workspaces cleanly separate data and access for multi-tenant or multi-environment setups.",
    },
  },
  sections: [
    {
      id: "create",
      title: { bn: "নতুন workspace", en: "Create workspace" },
      whatItDoes: { bn: "নাম দিয়ে workspace তৈরি করুন।", en: "Enter a name to create a workspace." },
      howToUse: [
        { bn: "Create Workspace চাপুন।", en: "Click Create Workspace." },
        { bn: "নাম দিয়ে confirm করুন।", en: "Enter a name and confirm." },
      ],
    },
    {
      id: "root",
      title: { bn: "Root workspace", en: "Root workspace" },
      whatItDoes: {
        bn: "'root' workspace-টি env-configured কী দিয়ে চলে — এটি delete করা যায় না।",
        en: "The 'root' workspace uses env-configured keys and cannot be deleted.",
      },
    },
    {
      id: "switch",
      title: { bn: "Workspace switch", en: "Switch workspace" },
      whatItDoes: {
        bn: "উপরের dropdown থেকে active workspace বদলান — সব pages ঐ context-এ চলবে।",
        en: "Change the active workspace from the top dropdown — all pages respect that context.",
      },
    },
  ],
};
