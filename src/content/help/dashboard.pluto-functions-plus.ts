import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-functions-plus — advanced edge functions surface: cron, secrets, logs across all functions.
export const dashboardPlutoFunctionsPlusHelp: PageHelp = {
  slug: "dashboard.pluto-functions-plus",
  page: {
    title: { bn: "Edge Functions — Cron, Secrets, Logs (workspace view)", en: "Edge Functions — Cron, Secrets, Logs (workspace view)" },
    whatItDoes: {
      bn: "সব function জুড়ে cross-function view: active cron schedule list, workspace-level shared secret, এবং centralized log explorer (function, status, latency, time-range filter সহ)।",
      en: "Cross-function view across the workspace: all active cron schedules, workspace-shared secrets, and a centralized log explorer with function/status/latency/time filters.",
    },
    whyItMatters: {
      bn: "10-20টা function হলে per-function tab-এ যাওয়া অসম্ভব। এখান থেকে একবারে কোন schedule আজ ফায়ার করেছে, কোন function-এ কত error, common secret কোথায় ব্যবহার হচ্ছে — সব দেখা যায়।",
      en: "With 10-20 functions, per-function tabs don't scale. This view answers 'which schedule fired today', 'which function is erroring most', 'where is this shared secret used' — at a glance.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "Tab: Cron · Secrets · Logs। প্রতিটি tab-এ workspace-wide list, filter, ও bulk action।",
        en: "Tabs: Cron · Secrets · Logs. Each has a workspace-wide list, filters, and bulk actions.",
      },
    },
    {
      id: "cron",
      title: { bn: "Cron overview", en: "Cron overview" },
      whatItDoes: { bn: "Cron overview", en: "Cron overview" },
      howToUse: [
        { bn: "ধাপ ১: 'Cron' tab → সব function-এর active schedule।", en: "Step 1: 'Cron' tab → every active schedule across functions." },
        { bn: "ধাপ ২: row-এ 'Next run' এবং 'Last status' দেখুন।", en: "Step 2: check 'Next run' and 'Last status' per row." },
        { bn: "ধাপ ৩: bulk Pause/Resume checkbox দিয়ে করুন।", en: "Step 3: bulk Pause/Resume via checkboxes." },
      ],
    },
    {
      id: "secrets",
      title: { bn: "Workspace secret", en: "Workspace secrets" },
      whatItDoes: {
        bn: "কিছু secret (Stripe key, SMTP password) একাধিক function share করে। এগুলো workspace-level রাখলে rotate একবারই লাগে।",
        en: "Some secrets (Stripe key, SMTP password) are shared across functions. Storing them workspace-wide means one rotation covers everything.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Secrets' → '+ Add' → key/value → scope (workspace বা function list)।", en: "Step 1: 'Secrets' → '+ Add' → key/value → scope (workspace or specific functions)." },
        { bn: "ধাপ ২: 'Used by' column-এ কোন কোন function reference করে দেখুন।", en: "Step 2: check 'Used by' to see which functions reference it." },
      ],
    },
    {
      id: "logs",
      title: { bn: "Log explorer", en: "Log explorer" },
      whatItDoes: { bn: "Log explorer", en: "Log explorer" },
      howToUse: [
        { bn: "ধাপ ১: filter set — function, status (2xx/4xx/5xx), latency threshold, time range।", en: "Step 1: set filters — function, status (2xx/4xx/5xx), latency threshold, time range." },
        { bn: "ধাপ ২: row expand → full request headers, response body, execution trace।", en: "Step 2: expand a row for full request headers, response body, execution trace." },
        { bn: "ধাপ ৩: 'Export CSV' দিয়ে incident report-এ attach করুন।", en: "Step 3: 'Export CSV' for incident reports." },
      ],
      troubleshooting: [
        { problem: { bn: "Log দেখাচ্ছে না — 'no results'", en: "Empty log view — 'no results'" }, solution: { bn: "Time range widen করুন; workspace-level log retention 7 দিন default।", en: "Widen the time range; default log retention is 7 days." } },
      ],
    },
  ],
  glossary: [
    { term: "workspace secret", definition: { bn: "একাধিক function share করে এমন secret।", en: "A secret shared across multiple functions." } },
    { term: "latency", definition: { bn: "Invocation-এর duration (ms) — cold start সহ।", en: "Duration of an invocation in ms, cold start included." } },
  ],
};
