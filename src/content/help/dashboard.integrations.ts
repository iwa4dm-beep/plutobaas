import type { PageHelp } from "@/lib/help/types";

// /dashboard/integrations — live readiness of optional Pluto modules
// (MFA, SSO, Push, Templates, AI/Vector, Broadcast, etc.).
export const dashboardIntegrationsHelp: PageHelp = {
  slug: "dashboard.integrations",
  page: {
    title: {
      bn: "Integration Health — মডিউলগুলোর লাইভ অবস্থা",
      en: "Integration Health — live module readiness",
    },
    whatItDoes: {
      bn: "এই পেইজ Pluto-এর optional module-গুলোর (MFA, SSO, Push notification, Email/SMS template, AI Gateway, Vector, Broadcast ইত্যাদি) ready/not-ready অবস্থা রিয়েল-টাইমে দেখায়।",
      en: "Shows the live ready/not-ready status of Pluto's optional modules — MFA, SSO, Push, Templates, AI Gateway, Vector, Broadcast, and more.",
    },
    whyItMatters: {
      bn: "কোনো feature client app-এ কাজ না করলে আগে এই পেইজে এসে দেখুন সংশ্লিষ্ট module actually enabled/configured কিনা — অনেক সমস্যা এখানেই ধরা পড়ে।",
      en: "If a feature isn't working in your app, check here first — most issues turn out to be a module that isn't enabled or configured.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "প্রতিটা module-এর জন্য একটা row — নাম, status badge (green=ready, amber=partial, red=down), শেষ probe-এর সময়, এবং configuration action।",
        en: "Each module has a row: name, status badge (green=ready, amber=partial, red=down), last probe time, and a configure action.",
      },
    },
    {
      id: "how-it-checks",
      title: { bn: "চেক কীভাবে হয়", en: "How the checks run" },
      whatItDoes: {
        bn: "Backend-এর `/integrations/v1/health` endpoint প্রতিটা module-এর জন্য একটা lightweight probe চালায় — কোনটার config missing, কোনটার key expired, আর কোনটা fully live সেটা এক response-এ ফেরত দেয়।",
        en: "The backend's `/integrations/v1/health` endpoint runs a lightweight probe per module and returns which are missing config, which have expired keys, and which are fully live.",
      },
      howToUse: [
        { bn: "উপরের 'Refresh' চাপুন probe আবার চালাতে।", en: "Hit 'Refresh' at the top to re-probe." },
        { bn: "যেকোন red/amber row-এ 'Configure' চাপুন — সংশ্লিষ্ট setting পেইজে নিয়ে যাবে।", en: "Click 'Configure' on any red/amber row — jumps to that module's setting page." },
        { bn: "Row expand করলে missing secret বা partial capability দেখাবে।", en: "Expand a row to see missing secrets or partial capability." },
      ],
    },
    {
      id: "modules",
      title: { bn: "প্রধান module-গুলো", en: "Key modules covered" },
      whatItDoes: {
        bn: "MFA (TOTP + WebAuthn), SSO (SAML/OIDC), Push (FCM/APNs), Email/SMS templates, AI Gateway (chat/embedding), Vector (pgvector), Broadcast (websocket), Realtime CDC — প্রতিটার আলাদা health probe আছে।",
        en: "MFA (TOTP + WebAuthn), SSO (SAML/OIDC), Push (FCM/APNs), Email/SMS templates, AI Gateway (chat/embedding), Vector (pgvector), Broadcast (websocket), Realtime CDC — each has its own probe.",
      },
      fields: [
        { name: "MFA", purpose: { bn: "TOTP এবং WebAuthn সেটআপ ঠিক আছে কিনা।", en: "TOTP + WebAuthn configuration is intact." } },
        { name: "SSO", purpose: { bn: "SAML/OIDC provider metadata reachable কিনা।", en: "SAML/OIDC provider metadata is reachable." } },
        { name: "Push", purpose: { bn: "FCM server key এবং APNs cert valid কিনা।", en: "FCM key and APNs cert are valid." } },
        { name: "AI Gateway", purpose: { bn: "AI provider API key ও quota available কিনা।", en: "AI provider key + quota are healthy." } },
        { name: "Vector", purpose: { bn: "pgvector extension ও index অ্যাভেইলেবল কিনা।", en: "pgvector extension and index are available." } },
      ],
    },
    {
      id: "statuses",
      title: { bn: "Status অর্থ", en: "What each status means" },
      whatItDoes: {
        bn: "green = পুরোপুরি ready, amber = কিছু capability missing (যেমন Push আছে কিন্তু APNs নেই), red = module একেবারেই কাজ করছে না বা enable করা নেই।",
        en: "green = fully ready, amber = partial (e.g. Push enabled but APNs missing), red = module is down or not enabled.",
      },
      troubleshooting: [
        {
          problem: { bn: "সব module red দেখাচ্ছে", en: "All modules show red" },
          solution: {
            bn: "Backend সংযোগ ভাঙা — Overview পেইজে গিয়ে backend health দেখুন এবং /dashboard/verify চালান।",
            en: "Backend connection is broken — check backend health on Overview and run /dashboard/verify.",
          },
        },
        {
          problem: { bn: "একটা module amber, কী missing?", en: "One module is amber — what's missing?" },
          solution: {
            bn: "Row expand করলে specific secret/config-এর নাম দেখাবে; সেটা /dashboard/tokens বা module-এর নিজস্ব পেইজে সেট করুন।",
            en: "Expand the row to see the specific missing secret/config; set it under /dashboard/tokens or the module's own page.",
          },
        },
      ],
    },
  ],
  glossary: [
    { term: "probe", definition: { bn: "Lightweight health check যা module actually কাজ করছে কিনা তা যাচাই করে।", en: "A lightweight check that confirms the module actually works." } },
    { term: "partial", definition: { bn: "Module-এর কিছু feature কাজ করছে, বাকিগুলো নয়।", en: "Some features of the module work, others don't." } },
  ],
};
