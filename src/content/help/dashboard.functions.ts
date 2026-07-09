import type { PageHelp } from "@/lib/help/types";

// /dashboard/functions — Edge Functions catalog, secrets, schedules, invocations.
export const dashboardFunctionsHelp: PageHelp = {
  slug: "dashboard.functions",
  page: {
    title: { bn: "Edge Functions — deploy, secret, schedule, invocation", en: "Edge Functions — deploy, secrets, schedules, invocations" },
    whatItDoes: {
      bn: "Deployed edge function list, per-function secret, cron schedule, এবং সাম্প্রতিক invocation log — সব এক scroll-এ। এখান থেকে function pause/resume, secret rotate, manual invoke করা যায়।",
      en: "Deployed functions, per-function secrets, cron schedules, and recent invocation logs — all in one view. Pause/resume, rotate secrets, and trigger manual invokes here.",
    },
    whyItMatters: {
      bn: "Backend business logic (webhook receiver, image processor, scheduled cleanup) client-এ বসে না। Edge function দিলে low-latency global edge-এ run হয়, তাই এই console-ই deploy-parity check করার জায়গা।",
      en: "Backend logic (webhook receivers, image jobs, scheduled cleanups) doesn't belong in the client. Edge functions run globally at low latency; this console is your deploy-parity check.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "উপরে function catalog (name, version, status)। প্রতিটা row-এ Secrets, Schedule, Logs, Invoke বাটন।",
        en: "Top: function catalog (name, version, status). Each row exposes Secrets, Schedule, Logs, Invoke.",
      },
    },
    {
      id: "secret",
      title: { bn: "Secret manage", en: "Managing secrets" },
      howToUse: [
        { bn: "ধাপ ১: function row → 'Secrets'।", en: "Step 1: row → 'Secrets'." },
        { bn: "ধাপ ২: key/value যোগ করুন → Save (encrypted-at-rest)।", en: "Step 2: add key/value → Save (encrypted at rest)." },
        { bn: "ধাপ ৩: function code-এ `Deno.env.get('KEY')` দিয়ে read করুন।", en: "Step 3: read from function code with `Deno.env.get('KEY')`." },
        { bn: "ধাপ ৪: rotate করতে value overwrite করুন — পরের invoke থেকে effective।", en: "Step 4: rotate by overwriting the value — effective from the next invoke." },
      ],
    },
    {
      id: "schedule",
      title: { bn: "Cron schedule", en: "Cron schedules" },
      howToUse: [
        { bn: "ধাপ ১: 'Schedule' → cron expression দিন (`*/5 * * * *`)।", en: "Step 1: 'Schedule' → cron expression (`*/5 * * * *`)." },
        { bn: "ধাপ ২: payload JSON (optional) → Save।", en: "Step 2: optional payload JSON → Save." },
        { bn: "ধাপ ৩: Pause চাপলে schedule বন্ধ, code untouched।", en: "Step 3: 'Pause' halts the schedule without touching code." },
      ],
    },
    {
      id: "invoke",
      title: { bn: "Manual invoke ও log", en: "Manual invoke & logs" },
      howToUse: [
        { bn: "ধাপ ১: 'Invoke' → method + JSON body → Run।", en: "Step 1: 'Invoke' → method + JSON body → Run." },
        { bn: "ধাপ ২: response body, status code, execution time দেখা যাবে।", en: "Step 2: response body, status, and execution time appear inline." },
        { bn: "ধাপ ৩: 'Logs' tab-এ recent invocation-এর stdout/stderr filter করা যায় (status, duration, time)।", en: "Step 3: 'Logs' tab lets you filter recent invocations by status, duration, and time." },
      ],
      troubleshooting: [
        { problem: { bn: "500 error, log-এ 'undefined env'", en: "500 with 'undefined env' in logs" }, solution: { bn: "Secret যোগ করতে ভুলে গেছেন — Secrets tab-এ check।", en: "You forgot the secret — check the Secrets tab." } },
        { problem: { bn: "Schedule fire করছে না", en: "Schedule not firing" }, solution: { bn: "Function status Paused কিনা দেখুন; cron expression validator দিয়ে verify করুন।", en: "Check if the function is Paused; verify the cron expression." } },
      ],
    },
  ],
  glossary: [
    { term: "edge function", definition: { bn: "Global edge-এ run হওয়া stateless Deno handler।", en: "A stateless Deno handler that runs at the global edge." } },
    { term: "cron", definition: { bn: "সময়সূচি expression (`min hour dom mon dow`) — যখন function auto invoke হবে।", en: "Schedule expression (`min hour dom mon dow`) that auto-invokes the function." } },
    { term: "invocation", definition: { bn: "একটা function run-এর record — input, output, duration, status সহ।", en: "One function run — input, output, duration, status." } },
  ],
};
