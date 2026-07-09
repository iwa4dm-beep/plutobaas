import type { PageHelp } from "@/lib/help/types";

export const dashboardEnterpriseHelp: PageHelp = {
  slug: "dashboard.enterprise",
  page: {
    title: { bn: "Enterprise ও Multi-region", en: "Enterprise & Multi-region" },
    whatItDoes: {
      bn: "IP access rules, custom domains, region routing এবং public status page — একটি জায়গা থেকে enterprise-grade controls।",
      en: "Enterprise-grade controls in one place: IP access rules, custom domains, region routing, and the public status page.",
    },
    whyItMatters: {
      bn: "Large customers প্রায়ই SOC2/ISO context-এ IP allowlist ও region pinning চায় — এগুলো এখান থেকে toggle করা যায়।",
      en: "Large customers often require IP allow-listing and region pinning for SOC2/ISO — all toggled from here.",
    },
  },
  sections: [
    {
      id: "ip-rules",
      title: { bn: "IP access rules", en: "IP access rules" },
      whatItDoes: {
        bn: "শুধু allowlisted CIDR range থেকে API traffic accept করার rule set করুন।",
        en: "Allow API traffic only from listed CIDR ranges.",
      },
      howToUse: [
        { bn: "CIDR range লিখুন (e.g. 203.0.113.0/24)।", en: "Enter a CIDR range (e.g. 203.0.113.0/24)." },
        { bn: "Add চাপুন — global CDN level-এ enforce হবে।", en: "Click Add — enforced at the global CDN layer." },
      ],
    },
    {
      id: "region",
      title: { bn: "Region routing", en: "Region routing" },
      whatItDoes: {
        bn: "Data residency requirement অনুযায়ী কোন region থেকে serve হবে সেটা set করুন।",
        en: "Pin serving to a specific region for data residency requirements.",
      },
    },
    {
      id: "status",
      title: { bn: "Public status page", en: "Public status page" },
      whatItDoes: {
        bn: "উপলব্ধতা, incidents ও historical uptime দেখানোর জন্য public URL এখান থেকে configure করুন।",
        en: "Configure the public URL that displays availability, incidents, and historical uptime.",
      },
    },
  ],
};
