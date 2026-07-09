import type { PageHelp } from "@/lib/help/types";

export const dashboardPlutoMarketplaceHelp: PageHelp = {
  slug: "dashboard.pluto-marketplace",
  page: {
    title: { bn: "মার্কেটপ্লেস ও এক্সটেনশন", en: "Marketplace & Extensions" },
    whatItDoes: {
      bn: "Third-party extensions (auth providers, storage adapters, AI models, integrations) browse ও install করুন এক ক্লিকে।",
      en: "Browse and one-click install third-party extensions — auth providers, storage adapters, AI models, and integrations.",
    },
    whyItMatters: {
      bn: "Common feature নিজে না বানিয়ে audited extension install করলে দ্রুত ship করা যায়।",
      en: "Installing audited extensions is faster than rebuilding common features yourself.",
    },
  },
  sections: [
    {
      id: "browse",
      title: { bn: "Browse", en: "Browse" },
      whatItDoes: { bn: "Category-wise extensions filter করে দেখুন।", en: "Filter and browse extensions by category." },
    },
    {
      id: "install",
      title: { bn: "Install", en: "Install" },
      whatItDoes: {
        bn: "Install চাপলে required secrets prompt আসবে এবং workspace-এ enable হয়ে যাবে।",
        en: "Click Install — required secrets are prompted and the extension is enabled in the workspace.",
      },
      howToUse: [
        { bn: "Extension card-এ Install চাপুন।", en: "Click Install on the extension card." },
        { bn: "Required secrets/config দিন।", en: "Provide required secrets/config." },
        { bn: "Enable হলে docs link ফলো করে integrate করুন।", en: "Once enabled, follow the docs link to integrate." },
      ],
    },
    {
      id: "uninstall",
      title: { bn: "Uninstall", en: "Uninstall" },
      whatItDoes: {
        bn: "Extension সরিয়ে দিলে associated secrets ও hooks-ও clean-up হয়।",
        en: "Removing an extension also cleans up its associated secrets and hooks.",
      },
    },
  ],
};
