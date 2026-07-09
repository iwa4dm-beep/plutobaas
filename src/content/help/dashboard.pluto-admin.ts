import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-admin — connect to upstream Pluto BaaS and manage
// projects / members / API keys.
export const dashboardPlutoAdminHelp: PageHelp = {
  slug: "dashboard.pluto-admin",
  page: {
    title: {
      bn: "Pluto Admin — self-hosted BaaS কন্ট্রোল",
      en: "Pluto Admin — self-hosted BaaS control",
    },
    whatItDoes: {
      bn: "এই পেইজ থেকে আপনার নিজস্ব VPS-এ চলা Pluto backend-এর সাথে সরাসরি সংযোগ করে project তৈরি/মুছে ফেলা, member যোগ/সরানো এবং API key mint/rotate/revoke করা যায়।",
      en: "Connect directly to your self-hosted Pluto backend to create/delete projects, add/remove members, and mint/rotate/revoke API keys.",
    },
    whyItMatters: {
      bn: "Self-hosted Pluto চালালে এটা হলো root-level অ্যাডমিন কনসোল। এখানে ভুল হলে পুরো tenancy ভেঙে যেতে পারে, তাই সাবধানে ব্যবহার করবেন।",
      en: "On self-hosted Pluto this is the root-level admin console. Mistakes here can break every tenant, so use it carefully.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "তিনটা tab আছে — Projects (tenant বানান/মুছুন), Members (কাকে access দেবেন), Keys (anon/authenticated/service_role API key মিন্ট করুন)। সব operation upstream Pluto backend-এর /admin/v1 API-তে যায়।",
        en: "Three tabs: Projects (create/delete tenants), Members (who has access), Keys (mint anon/authenticated/service_role keys). Every op hits your upstream /admin/v1 API.",
      },
    },
    {
      id: "connect",
      title: { bn: "Upstream সংযোগ", en: "Upstream connection" },
      whatItDoes: {
        bn: "উপরের 'Upstream connection' card-এ backend-এর base URL এবং একটা admin JWT দিতে হবে। JWT না থাকলে email/password দিয়ে সরাসরি sign-in করে token নেওয়া যাবে।",
        en: "The 'Upstream connection' card takes your backend base URL and an admin JWT. If you have no token, sign in with email/password to mint one.",
      },
      howToUse: [
        { bn: "Upstream URL ফিল্ডে লিখুন — যেমন `https://api.your-domain.com`।", en: "Enter the upstream URL, e.g. `https://api.your-domain.com`." },
        { bn: "Admin JWT paste করুন, অথবা নিচের email/password দিয়ে Sign in চাপুন।", en: "Paste an admin JWT, or use the Sign-in row below." },
        { bn: "URL ও token localStorage-এ save হয়ে থাকে; browser বদলালে আবার দিতে হবে।", en: "URL/token are kept in localStorage — you'll re-enter on a new browser." },
      ],
      fields: [
        { name: "Upstream URL", purpose: { bn: "যে VPS-এ Pluto backend চলছে সেটার public HTTPS URL।", en: "Public HTTPS URL of the VPS running the Pluto backend." }, example: "https://api.timescard.cloud" },
        { name: "Admin JWT", purpose: { bn: "Root/superadmin role-এর access token।", en: "Access token for a root/superadmin account." } },
      ],
    },
    {
      id: "projects",
      title: { bn: "Projects tab", en: "Projects tab" },
      whatItDoes: {
        bn: "নতুন project (Pluto tenant) তৈরি, list, বা delete করুন। প্রতিটা project-এর একটা slug থাকে যেটা API URL-এ ব্যবহৃত হয়।",
        en: "Create, list, or delete Pluto projects (tenants). Each project has a slug used in its API URLs.",
      },
      howToUse: [
        { bn: "Name এবং slug (শুধু a-z 0-9 -) দিয়ে 'Create' চাপুন।", en: "Type Name + slug (a-z 0-9 -) and click 'Create'." },
        { bn: "যেকোন row-এর 'Members' বা 'Keys' বাটন চেপে সংশ্লিষ্ট tab-এ যান।", en: "Use 'Members' or 'Keys' on a row to open that tab scoped to it." },
        { bn: "Delete করলে project-এর সব data, user, key মুছে যাবে — ফেরত আনা যাবে না।", en: "Delete removes all project data, users, and keys — irreversible." },
      ],
    },
    {
      id: "members",
      title: { bn: "Members tab", en: "Members tab" },
      whatItDoes: {
        bn: "একটা project-এ কাকে কী role-এ যোগ করা হবে সেটা এখান থেকে ঠিক করা যায়। role হতে পারে owner, admin, developer, বা viewer।",
        en: "Assign roles (owner, admin, developer, viewer) to users on a specific project.",
      },
      howToUse: [
        { bn: "প্রথমে Projects tab থেকে একটা project বেছে নিন।", en: "Pick a project from the Projects tab first." },
        { bn: "user_id (uuid) এবং role দিয়ে 'Add' চাপুন।", en: "Enter user_id (uuid) + role and hit 'Add'." },
        { bn: "trash icon-এ ক্লিক করে member সরান।", en: "Click the trash icon to remove a member." },
      ],
      troubleshooting: [
        {
          problem: { bn: "user_id কোথায় পাবো?", en: "Where do I find a user_id?" },
          solution: {
            bn: "/dashboard/users পেইজে গিয়ে user-এর uuid কপি করুন।", en: "Open /dashboard/users and copy the user's uuid.",
          },
        },
      ],
    },
    {
      id: "keys",
      title: { bn: "API Keys tab", en: "API Keys tab" },
      whatItDoes: {
        bn: "প্রতিটা project-এর জন্য তিন ধরনের API key mint করা যায় — anon (public, RLS-এর মাধ্যমে সীমাবদ্ধ), authenticated (user-token-এর সাথে), এবং service_role (RLS bypass করে, শুধুমাত্র backend-এ ব্যবহার্য)।",
        en: "Mint three key types per project — anon (public, gated by RLS), authenticated (paired with a user token), and service_role (bypasses RLS, backend-only).",
      },
      howToUse: [
        { bn: "Name দিয়ে role বেছে 'Mint' চাপুন।", en: "Enter Name, pick role, click 'Mint'." },
        { bn: "যে dialog আসবে সেখানে key একবারই দেখাবে — copy করে secret manager-এ রাখুন।", en: "The dialog shows the key once — copy it to your secret manager." },
        { bn: "'Rotate' key-কে revoke করে নতুন replacement দেয়; পুরনোটা সাথে সাথে fail করবে।", en: "'Rotate' revokes the old key and issues a replacement; the old one fails immediately." },
        { bn: "'Revoke' পুরোপুরি key বাতিল করে দেয়।", en: "'Revoke' kills the key permanently." },
      ],
      troubleshooting: [
        {
          problem: { bn: "service_role key কি ব্রাউজারে ব্যবহার করা যাবে?", en: "Can I use service_role in the browser?" },
          solution: {
            bn: "কখনোই না। শুধুমাত্র server-side (edge function, backend job) ব্যবহার করুন — RLS bypass করে।",
            en: "Never. Use it only server-side (edge functions, backend jobs) — it bypasses RLS.",
          },
        },
      ],
    },
  ],
  glossary: [
    { term: "anon", definition: { bn: "Public API key — শুধুমাত্র RLS policy যা allow করে তা-ই পড়তে/লিখতে পারে।", en: "Public API key limited by RLS policies." } },
    { term: "service_role", definition: { bn: "সর্বোচ্চ privilege key, RLS bypass করে; শুধু server-side।", en: "Highest-privilege key that bypasses RLS; server-side only." } },
    { term: "rotate", definition: { bn: "পুরনো key revoke করে নতুন replacement mint করে।", en: "Revokes the old key and mints a replacement." } },
  ],
};
