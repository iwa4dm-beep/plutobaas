import type { PageHelp } from "@/lib/help/types";

export const dashboardPlutoComplianceHelp: PageHelp = {
  slug: "dashboard.pluto-compliance",
  page: {
    title: { bn: "কমপ্লায়েন্স — PII, DSAR, Retention, Audit sealing", en: "Compliance — PII, DSAR, Retention, Audit sealing" },
    whatItDoes: {
      bn: "GDPR/CCPA-এর জন্য PII column tagging, DSAR (export/delete) request handling, data retention policy এবং tamper-proof audit log sealing এক জায়গায়।",
      en: "One page for GDPR/CCPA needs: PII column tagging, DSAR export/delete handling, retention policies, and tamper-proof audit log sealing.",
    },
    whyItMatters: {
      bn: "Regulatory audit-এ ধরা পড়লে fine এবং reputational risk বিশাল; automated compliance tooling ছাড়া manual চালানো অসম্ভব।",
      en: "Regulatory audits carry heavy fines and reputational risk; manual compliance is not sustainable without tooling.",
    },
  },
  sections: [
    {
      id: "pii",
      title: { bn: "PII tagging", en: "PII tagging" },
      whatItDoes: { bn: "যে সব column-এ personal data আছে সেগুলোকে PII হিসেবে mark করুন।", en: "Tag columns containing personal data as PII." },
      howToUse: [
        { bn: "Table বেছে column-এ PII toggle অন করুন।", en: "Select a table and toggle PII on the column." },
        { bn: "DSAR export/delete-এ এই column-গুলোই process হবে।", en: "Only tagged columns are processed for DSAR export/delete." },
      ],
    },
    {
      id: "dsar",
      title: { bn: "DSAR requests", en: "DSAR requests" },
      whatItDoes: {
        bn: "কোনো user-এর data export বা erase request ট্র্যাক ও execute করুন।",
        en: "Track and execute per-user data export or erase requests.",
      },
    },
    {
      id: "retention",
      title: { bn: "Retention policy", en: "Retention policy" },
      whatItDoes: {
        bn: "প্রতিটি table-এর জন্য age limit set করুন — expired rows scheduled job-এ auto-delete হবে।",
        en: "Set an age limit per table — expired rows are auto-deleted by a scheduled job.",
      },
    },
    {
      id: "audit-seal",
      title: { bn: "Audit sealing", en: "Audit sealing" },
      whatItDoes: {
        bn: "Audit log periodically hash-chained এবং external witness-এ signed — tampering detect করা যায়।",
        en: "The audit log is periodically hash-chained and signed by an external witness so tampering can be detected.",
      },
    },
  ],
};
