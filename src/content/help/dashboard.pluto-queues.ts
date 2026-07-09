import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-queues — queues, background jobs, DLQ, retries.
export const dashboardPlutoQueuesHelp: PageHelp = {
  slug: "dashboard.pluto-queues",
  page: {
    title: { bn: "Queues & Background Jobs", en: "Queues & Background Jobs" },
    whatItDoes: {
      bn: "Named queue তৈরি, job enqueue/inspect/replay, retry policy (max attempts, backoff), এবং dead-letter queue (DLQ) management — সব এক জায়গায়।",
      en: "Create named queues, enqueue/inspect/replay jobs, tune retry policy (max attempts, backoff), and manage the dead-letter queue — all in one place.",
    },
    whyItMatters: {
      bn: "Email send, PDF generate, webhook fan-out — এগুলো request thread-এ করলে user wait করে ও failure retry নেই। Queue দিলে fire-and-forget হয়, failure retryable হয়, DLQ debug-এ সাহায্য করে।",
      en: "Sending email, generating PDFs, fanning out webhooks in-request makes users wait and swallows failures. Queues make it fire-and-forget, retryable, and DLQ makes failures debuggable.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "Tab: Queues · Jobs · DLQ · Metrics। Queue-এ depth, throughput, error-rate graph।",
        en: "Tabs: Queues · Jobs · DLQ · Metrics. Queue view shows depth, throughput, and error-rate graphs.",
      },
    },
    {
      id: "queue",
      title: { bn: "Queue তৈরি", en: "Creating a queue" },
      howToUse: [
        { bn: "ধাপ ১: '+ New queue' → নাম (`emails`, `pdf-render`)।", en: "Step 1: '+ New queue' → name (`emails`, `pdf-render`)." },
        { bn: "ধাপ ২: max attempts (3-5 recommend), backoff (exponential, base 30s)।", en: "Step 2: max attempts (3-5 recommended), backoff (exponential, base 30s)." },
        { bn: "ধাপ ৩: visibility timeout (worker কতক্ষণ hold করবে) — job-এর ETA-এর 2x রাখুন।", en: "Step 3: visibility timeout (how long a worker holds a job) — set to 2× the job's ETA." },
        { bn: "ধাপ ৪: Save → SDK-তে `pluto.queue('emails').enqueue({...})`।", en: "Step 4: Save → from the SDK `pluto.queue('emails').enqueue({...})`." },
      ],
    },
    {
      id: "jobs",
      title: { bn: "Job inspect ও replay", en: "Inspecting & replaying jobs" },
      howToUse: [
        { bn: "ধাপ ১: 'Jobs' tab → filter status (queued/running/succeeded/failed)।", en: "Step 1: 'Jobs' tab → filter by status (queued/running/succeeded/failed)." },
        { bn: "ধাপ ২: row expand → payload, attempts, last error stack।", en: "Step 2: expand a row for payload, attempts, last error stack." },
        { bn: "ধাপ ৩: 'Replay' চাপলে attempt counter reset হয়ে re-enqueue।", en: "Step 3: 'Replay' resets attempts and re-enqueues." },
      ],
    },
    {
      id: "dlq",
      title: { bn: "Dead-letter queue", en: "Dead-letter queue" },
      whatItDoes: {
        bn: "Max attempt-এর পরেও fail করা job DLQ-তে যায়। এখান থেকে root cause খুঁজে fix করে bulk-replay করা যায়।",
        en: "Jobs that exhaust max attempts land in DLQ. Diagnose here, fix upstream, then bulk-replay.",
      },
      troubleshooting: [
        { problem: { bn: "Queue depth বাড়ছে কিন্তু worker consume করছে না", en: "Queue depth rising, workers not consuming" }, solution: { bn: "Worker token expired/revoked কিনা /dashboard/jobs-এ check করুন; Metrics tab-এ throughput 0 হলে scale-out দরকার।", en: "Check /dashboard/jobs for expired/revoked worker tokens; if Metrics shows throughput=0, scale out workers." } },
        { problem: { bn: "একই job বারবার DLQ-এ যাচ্ছে replay করলেও", en: "Same job keeps landing in DLQ after replay" }, solution: { bn: "Payload-এ bug — 'View payload' দিয়ে raw data দেখুন, code fix করে তারপর replay।", en: "Payload has a bug — use 'View payload' to inspect raw data, fix code, then replay." } },
      ],
    },
  ],
  glossary: [
    { term: "queue", definition: { bn: "Named FIFO channel যেখানে job push হয় ও worker pull করে।", en: "A named FIFO channel workers pull jobs from." } },
    { term: "DLQ", definition: { bn: "Dead-Letter Queue — permanently failed job-এর ঠাঁই।", en: "Dead-Letter Queue — where permanently failed jobs end up." } },
    { term: "visibility timeout", definition: { bn: "Job pop হওয়ার পর কতক্ষণ অন্য worker-এর দেখা থেকে hidden থাকবে।", en: "How long a popped job stays hidden from other workers." } },
    { term: "backoff", definition: { bn: "Retry-এর মধ্যে delay strategy (linear/exponential)।", en: "Delay strategy between retries (linear/exponential)." } },
  ],
};
