import type { PageHelp } from "@/lib/help/types";

// /dashboard — Overview home. Landing screen of the admin console.
export const dashboardIndexHelp: PageHelp = {
  slug: "dashboard.index",
  page: {
    title: {
      bn: "ওভারভিউ — এক নজরে আপনার backend",
      en: "Overview — your backend at a glance",
    },
    whatItDoes: {
      bn: "এই পেইজ হলো Pluto অ্যাডমিন কনসোলের হোম স্ক্রিন। এখানে আপনার active workspace, backend সংযোগের অবস্থা, key শর্টকাট এবং সাম্প্রতিক কার্যকলাপ একসাথে দেখা যায়।",
      en: "The home screen of the Pluto admin console — shows your active workspace, backend connection status, quick shortcuts, and recent activity in one view.",
    },
    whyItMatters: {
      bn: "প্রতিদিনের কাজ শুরু করার আগে এখানে এক নজরে দেখে নিতে পারবেন — backend live আছে কিনা, কোন workspace-এ আছেন, এবং পরবর্তী কাজে দ্রুত ঝাঁপ দেওয়া যাবে।",
      en: "Before starting daily work you can confirm the backend is live, which workspace is active, and jump straight into the next task.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "Overview পেইজ চারটা কাজ করে — (১) workspace switcher দেখায়, (২) backend URL ও health দেখায়, (৩) সবচেয়ে বেশি ব্যবহৃত section-এ shortcut card দেয়, (৪) সাম্প্রতিক audit/deploy event দেখায়।",
        en: "The Overview does four things: shows the workspace switcher, shows backend URL + health, offers shortcut cards to the busiest sections, and lists recent audit/deploy events.",
      },
    },
    {
      id: "workspace",
      title: { bn: "Workspace নির্বাচন", en: "Workspace selection" },
      whatItDoes: {
        bn: "উপরে বামে যে dropdown আছে, সেখান থেকে workspace বদলানো যায়। প্রতিটা workspace-এর নিজস্ব database, API key, user, storage bucket, এবং custom domain থাকে — একটার data অন্যটায় দেখা যাবে না।",
        en: "The dropdown top-left switches workspaces. Each workspace owns its own database, API keys, users, storage buckets, and custom domains — data never leaks between them.",
      },
      whenToUse: {
        bn: "একাধিক client বা environment (dev/staging/prod) আলাদা রাখতে চাইলে আলাদা workspace বানান।",
        en: "Use separate workspaces to isolate different clients or environments (dev/staging/prod).",
      },
      howToUse: [
        { bn: "Dropdown-এ ক্লিক করুন এবং workspace বাছাই করুন।", en: "Click the dropdown and pick a workspace." },
        { bn: "'+ New workspace' চেপে নতুন workspace তৈরি করুন।", en: "Hit '+ New workspace' to create one." },
        { bn: "প্রতিটা workspace-এর জন্য আলাদা API token issue করতে হবে (/dashboard/tokens)।", en: "Issue a separate API token per workspace under /dashboard/tokens." },
      ],
    },
    {
      id: "health",
      title: { bn: "Backend health card", en: "Backend health card" },
      whatItDoes: {
        bn: "কার্ডে দেখাবে backend URL, region, uptime %, latest deploy version, এবং সবুজ/লাল indicator। ভিতরে ping করে /healthz এবং /readyz endpoint দুটোই যাচাই হয়।",
        en: "The card surfaces the backend URL, region, uptime %, latest deployed version, and a green/red indicator. Internally it pings /healthz and /readyz.",
      },
      troubleshooting: [
        {
          problem: { bn: "'Offline' দেখাচ্ছে", en: "Card shows 'Offline'" },
          solution: {
            bn: "PLUTO_UPSTREAM_URL secret ঠিক আছে কিনা দেখুন; VPS-এ `systemctl status pluto-backend` চালান; DNS/Caddy চেক করুন।",
            en: "Verify PLUTO_UPSTREAM_URL, run `systemctl status pluto-backend` on the VPS, and check DNS/Caddy.",
          },
        },
        {
          problem: { bn: "Uptime % কমে গেছে", en: "Uptime % is dropping" },
          solution: {
            bn: "Ops → Observability-এ গিয়ে recent incident দেখুন এবং integration health চেক করুন।",
            en: "Open Ops → Observability to see recent incidents and check integration health.",
          },
        },
      ],
    },
    {
      id: "shortcuts",
      title: { bn: "শর্টকাট কার্ডসমূহ", en: "Shortcut cards" },
      whatItDoes: {
        bn: "Database, Users, Storage, Realtime, Custom domains, API tokens — এই ছয়টা কার্ড এক ক্লিকে সংশ্লিষ্ট পেইজে নিয়ে যাবে।",
        en: "Six cards (Database, Users, Storage, Realtime, Custom domains, API tokens) jump-link into the matching admin section.",
      },
    },
    {
      id: "activity",
      title: { bn: "সাম্প্রতিক কার্যকলাপ", en: "Recent activity" },
      whatItDoes: {
        bn: "গত ৭ দিনের audit event (login, key rotate, migration, domain add ইত্যাদি) সময় অনুসারে দেখা যাবে। বিস্তারিত দেখতে Ops → Audit log-এ যান।",
        en: "Shows the last 7 days of audit events (logins, key rotations, migrations, domain changes). For the full history open Ops → Audit log.",
      },
    },
  ],
  glossary: [
    {
      term: "workspace",
      definition: {
        bn: "একটা লজিক্যাল টেন্যান্ট — নিজস্ব DB schema, RLS policy, API key এবং user list রাখে।",
        en: "A logical tenant with its own DB schema, RLS policies, API keys, and user list.",
      },
    },
    {
      term: "readyz",
      definition: {
        bn: "Backend request নিতে পুরোপুরি প্রস্তুত কিনা যাচাই করে (DB, cache, migration সব ready)।",
        en: "Confirms the backend is fully ready (DB, cache, migrations all up).",
      },
    },
  ],
};
