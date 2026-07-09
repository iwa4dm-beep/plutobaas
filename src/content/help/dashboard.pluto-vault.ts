import type { PageHelp } from "@/lib/help/types";

export const dashboardPlutoVaultHelp: PageHelp = {
  slug: "dashboard.pluto-vault",
  page: {
    title: { bn: "Vault ও Secrets", en: "Vault & Secrets" },
    whatItDoes: {
      bn: "API keys, external service credentials এবং encryption keys encrypted-at-rest ভাবে সংরক্ষণ ও server functions-এ inject করুন।",
      en: "Store API keys, external credentials, and encryption keys encrypted-at-rest and inject them into server functions.",
    },
    whyItMatters: {
      bn: "Secrets plain-text env file-এ রাখা risky — vault access-controlled, audited এবং rotatable রাখে।",
      en: "Plain-text env files are risky; the vault keeps secrets access-controlled, audited, and rotatable.",
    },
  },
  sections: [
    {
      id: "add",
      title: { bn: "Secret যোগ", en: "Add secret" },
      whatItDoes: { bn: "key name ও value দিয়ে vault-এ store করুন।", en: "Enter key name and value to store in the vault." },
      howToUse: [
        { bn: "Add Secret চাপুন।", en: "Click Add Secret." },
        { bn: "Name (SNAKE_CASE) ও value দিন।", en: "Enter SNAKE_CASE name and value." },
        { bn: "Save — server-side `process.env.<NAME>` দিয়ে access পাবেন।", en: "Save — access it server-side via `process.env.<NAME>`." },
      ],
      fields: [
        { name: "name", purpose: { bn: "Env var identifier", en: "Env var identifier" }, example: "STRIPE_SECRET_KEY" },
      ],
    },
    {
      id: "rotate",
      title: { bn: "Rotate", en: "Rotate" },
      whatItDoes: {
        bn: "Compromise সন্দেহ হলে সাথে সাথে value বদলান — next deploy-এ effective।",
        en: "If compromise is suspected, replace the value immediately — active on next deploy.",
      },
    },
    {
      id: "audit",
      title: { bn: "Access audit", en: "Access audit" },
      whatItDoes: {
        bn: "কে কখন কোন secret access করেছে সবই Audit log-এ থাকে।",
        en: "Every read/write of a secret is captured in the audit log with actor and timestamp.",
      },
    },
  ],
};
