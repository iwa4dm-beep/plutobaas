import type { PageHelp } from "@/lib/help/types";

export const dashboardAuditHelp: PageHelp = {
  slug: "dashboard.audit",
  page: {
    title: { bn: "Audit trail", en: "Audit trail" },
    whatItDoes: {
      bn: "Dashboard থেকে করা প্রতিটি privileged action — migration, storage grant, SQL runner run, API key issue — এখানে record হয় এবং real-time stream করে।",
      en: "Every privileged dashboard action — migrations, storage grants, SQL runner executions, API-key issuance — is recorded and streamed live here.",
    },
    whyItMatters: {
      bn: "Production-এ কে কখন কী করেছে তার প্রমাণ থাকে; compliance এবং incident investigation-এ অপরিহার্য।",
      en: "Provides a defensible record of who did what and when — essential for compliance and incident review.",
    },
  },
  sections: [
    {
      id: "filter",
      title: { bn: "ইভেন্ট ফিল্টার", en: "Filter events" },
      whatItDoes: {
        bn: "Action, workspace, বা actor দিয়ে filter করুন। preset dropdown থেকে দ্রুত category select করা যায়।",
        en: "Filter by action, workspace, or actor. The preset dropdown gives one-click category filters.",
      },
      fields: [
        { name: "action", purpose: { bn: "যেমন migration.* বা storage.sign*", en: "e.g. migration.* or storage.sign*" } },
        { name: "workspace", purpose: { bn: "নির্দিষ্ট tenant-এর event দেখতে", en: "Scope events to a specific tenant" } },
        { name: "actor", purpose: { bn: "কোন admin ইউজার", en: "Which admin user" } },
      ],
    },
    {
      id: "live",
      title: { bn: "Live stream", en: "Live stream" },
      whatItDoes: {
        bn: "উপরের green dot 'Live' দেখালে নতুন event auto append হবে। disconnect হলে auto-reconnect হয়।",
        en: "When the green 'Live' dot is on, new events append automatically. Disconnects reconnect on their own.",
      },
    },
    {
      id: "trouble",
      title: { bn: "সাধারণ সমস্যা", en: "Common issues" },
      whatItDoes: { bn: "", en: "" },
      troubleshooting: [
        {
          problem: { bn: "Event দেখাচ্ছে না", en: "Events not showing" },
          solution: {
            bn: "Service role key configured কিনা দেখুন; ForBidden হলে /dashboard/api থেকে নতুন key issue করুন।",
            en: "Confirm a service-role key is configured; on Forbidden, issue a new one from /dashboard/api.",
          },
        },
      ],
    },
  ],
};
