import type { PageHelp } from "@/lib/help/types";

export const dashboardPlutoReplicasHelp: PageHelp = {
  slug: "dashboard.pluto-replicas",
  page: {
    title: { bn: "মাল্টি-রিজিয়ন রিড রেপ্লিকা", en: "Multi-region Read Replicas" },
    whatItDoes: {
      bn: "বিভিন্ন geographic region-এ read-only PostgreSQL replica চালু করে latency কমানো হয়।",
      en: "Provision read-only PostgreSQL replicas across regions to reduce latency for users worldwide.",
    },
    whyItMatters: {
      bn: "Global apps-এ single-region DB থেকে reads slow হয় — replicas cross-region latency 100-300ms কমিয়ে দেয়।",
      en: "Single-region DB reads are slow for global apps — replicas cut cross-region latency by 100-300ms.",
    },
  },
  sections: [
    {
      id: "add",
      title: { bn: "Replica যোগ", en: "Add a replica" },
      whatItDoes: { bn: "Region বেছে নিয়ে replica provision করুন।", en: "Pick a region and provision a replica." },
      howToUse: [
        { bn: "Add Replica চাপুন।", en: "Click Add Replica." },
        { bn: "Region বেছে নিন (e.g. ap-south-1)।", en: "Choose a region (e.g. ap-south-1)." },
        { bn: "Provision শেষ হলে read endpoint URL কপি করুন।", en: "Once provisioned, copy the read endpoint URL." },
      ],
    },
    {
      id: "routing",
      title: { bn: "Read routing", en: "Read routing" },
      whatItDoes: {
        bn: "SDK-এ read pool URL সেট করলে read query auto-nearest replica-তে যাবে।",
        en: "Set the read pool URL in the SDK and reads route to the nearest replica automatically.",
      },
    },
    {
      id: "lag",
      title: { bn: "Replication lag", en: "Replication lag" },
      whatItDoes: {
        bn: "প্রতিটি replica-র current lag (seconds) দেখানো হয় — বেশি হলে alert configure করা যায়।",
        en: "Shows current lag (seconds) for each replica — configure alerts if it grows.",
      },
    },
  ],
};
