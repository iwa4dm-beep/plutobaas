import type { PageHelp } from "@/lib/help/types";

export const dashboardCustomDomainsHelp: PageHelp = {
  slug: "dashboard.custom-domains",
  page: {
    title: { bn: "কাস্টম ডোমেইন", en: "Custom domains" },
    whatItDoes: {
      bn: "আপনার নিজস্ব ডোমেইন (যেমন api.example.com) backend-এ attach করে TLS সার্টিফিকেট auto-provision করা হয়।",
      en: "Attach your own domain (e.g. api.example.com) to the backend and auto-provision a TLS certificate.",
    },
    whyItMatters: {
      bn: "Custom domain ছাড়া client apps default lovable.app subdomain-এ নির্ভরশীল থাকে যা branding ও portability দুর্বল করে।",
      en: "Without a custom domain, apps depend on the default lovable.app subdomain, weakening branding and portability.",
    },
  },
  sections: [
    {
      id: "add",
      title: { bn: "ডোমেইন যোগ", en: "Add a domain" },
      whatItDoes: { bn: "hostname লিখে Add চাপুন।", en: "Enter the hostname and click Add." },
      howToUse: [
        { bn: "Full hostname দিন (api.example.com)।", en: "Enter the full hostname (api.example.com)." },
        { bn: "Add চাপুন — pending status আসবে।", en: "Click Add — it enters pending status." },
      ],
    },
    {
      id: "dns",
      title: { bn: "DNS verification", en: "DNS verification" },
      whatItDoes: {
        bn: "দেখানো CNAME/TXT রেকর্ডটি আপনার DNS provider-এ যোগ করুন এবং Verify চাপুন।",
        en: "Add the shown CNAME/TXT record at your DNS provider, then click Verify.",
      },
      howToUse: [
        { bn: "শো করা টার্গেট মান হুবহু কপি করুন।", en: "Copy the shown target value verbatim." },
        { bn: "DNS provider-এ CNAME/TXT record তৈরি করুন।", en: "Create the CNAME/TXT record at your DNS provider." },
        { bn: "Verify চাপুন — propagation-এর কারণে কয়েক মিনিট লাগতে পারে।", en: "Click Verify — propagation may take a few minutes." },
      ],
      troubleshooting: [
        {
          problem: { bn: "Verify fail করছে", en: "Verify keeps failing" },
          solution: {
            bn: "`dig CNAME <domain>` চালিয়ে দেখুন target মিলে কিনা, TTL কমিয়ে আবার চেষ্টা করুন।",
            en: "Run `dig CNAME <domain>` to confirm the target matches, lower TTL, and retry.",
          },
        },
      ],
    },
    {
      id: "tls",
      title: { bn: "TLS সার্টিফিকেট", en: "TLS certificate" },
      whatItDoes: {
        bn: "verification সফল হলে Let's Encrypt সার্টিফিকেট auto-issue হয় এবং auto-renew চলতে থাকে।",
        en: "Once verified, a Let's Encrypt certificate is auto-issued and auto-renewed.",
      },
    },
    {
      id: "admins",
      title: { bn: "ডোমেইন অ্যাডমিন", en: "Domain admins" },
      whatItDoes: {
        bn: "প্রতিটি ডোমেইনের জন্য আলাদা admin scope দেওয়া যায় — শুধু ঐ ডোমেইনের DNS/TLS action-এ সীমাবদ্ধ।",
        en: "Grant per-domain admin scopes limited to DNS/TLS actions for that domain only.",
      },
    },
  ],
};
