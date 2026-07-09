import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-webhooks — outbound webhooks, event triggers, signing, delivery log.
export const dashboardPlutoWebhooksHelp: PageHelp = {
  slug: "dashboard.pluto-webhooks",
  page: {
    title: { bn: "Webhooks & Event Triggers", en: "Webhooks & Event Triggers" },
    whatItDoes: {
      bn: "Database event (INSERT/UPDATE/DELETE) বা custom event trigger হলে external URL-এ HMAC-signed POST পাঠানোর subscription তৈরি ও monitor করা যায়। Delivery attempt, retry, response body — সব log-এ থাকে।",
      en: "Subscribe external URLs to database events (INSERT/UPDATE/DELETE) or custom events; each event triggers an HMAC-signed POST. Attempts, retries, and response bodies are logged.",
    },
    whyItMatters: {
      bn: "Third-party integration (Slack notify, CRM sync, analytics pipeline) polling-এ করলে delay + wasted call। Webhook দিলে push হয় ঠিক event-এর মুহূর্তে।",
      en: "Third-party integrations (Slack notify, CRM sync, analytics) polling wastes calls and lags. Webhooks push exactly when the event happens.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "Tab: Subscriptions · Delivery log · Signing keys। প্রতিটি subscription-এ target URL, event filter, retry policy, HMAC secret।",
        en: "Tabs: Subscriptions · Delivery log · Signing keys. Each subscription has a target URL, event filter, retry policy, and HMAC secret.",
      },
    },
    {
      id: "subscribe",
      title: { bn: "Subscription তৈরি", en: "Create a subscription" },
      whatItDoes: { bn: "Subscription তৈরি", en: "Create a subscription" },
      howToUse: [
        { bn: "ধাপ ১: '+ New webhook' → target URL (HTTPS)।", en: "Step 1: '+ New webhook' → target URL (HTTPS)." },
        { bn: "ধাপ ২: event source — table (schema.table + INSERT/UPDATE/DELETE) বা custom event name।", en: "Step 2: event source — table (schema.table + INSERT/UPDATE/DELETE) or custom event name." },
        { bn: "ধাপ ৩: filter দিন (`status=eq.paid`) noise কমাতে।", en: "Step 3: add a filter (`status=eq.paid`) to cut noise." },
        { bn: "ধাপ ৪: Save → signing secret auto-generate; UI-তে একবার দেখাবে — copy করে receiver-এ set করুন।", en: "Step 4: Save → signing secret auto-generates; shown once — copy it into the receiver." },
      ],
    },
    {
      id: "signing",
      title: { bn: "Signature verification (receiver-side)", en: "Verifying signatures (receiver side)" },
      whatItDoes: {
        bn: "Header `x-pluto-signature` = `hex(HMAC_SHA256(secret, raw_body))`। Receiver-এ constant-time compare করুন।",
        en: "Header `x-pluto-signature` = `hex(HMAC_SHA256(secret, raw_body))`. Compare in constant time on the receiver.",
      },
      howToUse: [
        { bn: "ধাপ ১: raw request body বার করুন (JSON.parse-এর আগে)।", en: "Step 1: read the raw body before JSON.parse." },
        { bn: "ধাপ ২: `crypto.createHmac('sha256', secret).update(body).digest('hex')` compute করুন।", en: "Step 2: compute `crypto.createHmac('sha256', secret).update(body).digest('hex')`." },
        { bn: "ধাপ ৩: `timingSafeEqual` দিয়ে header-এর সাথে মিলিয়ে দেখুন — mismatch হলে 401 return।", en: "Step 3: `timingSafeEqual` against the header — mismatch → 401." },
      ],
    },
    {
      id: "delivery",
      title: { bn: "Delivery log ও retry", en: "Delivery log & retry" },
      whatItDoes: { bn: "Delivery log ও retry", en: "Delivery log & retry" },
      howToUse: [
        { bn: "ধাপ ১: 'Delivery log' → filter subscription/status/time।", en: "Step 1: 'Delivery log' → filter by subscription/status/time." },
        { bn: "ধাপ ২: failed row expand → response code, body, next retry time।", en: "Step 2: expand a failed row → response code, body, next retry ETA." },
        { bn: "ধাপ ৩: 'Redeliver' চেপে manual retry (attempt counter reset)।", en: "Step 3: 'Redeliver' for manual retry (resets attempts)." },
      ],
      troubleshooting: [
        { problem: { bn: "Receiver 200 return করলেও 'failed' লেখা", en: "Receiver returns 200 but log shows 'failed'" }, solution: { bn: "5s-এর বেশি delay হলে timeout — receiver-কে দ্রুত 200 return করে background-এ process করতে বলুন।", en: "Anything over 5s is a timeout — receive fast, do work in the background." } },
        { problem: { bn: "Signature mismatch 401", en: "Signature mismatch 401" }, solution: { bn: "Receiver parsed body-তে sign করছে; raw bytes দিয়ে sign করতে হবে।", en: "Receiver is signing the parsed body — sign the raw bytes instead." } },
      ],
    },
  ],
  glossary: [
    { term: "webhook", definition: { bn: "Event ঘটলে outbound HTTP POST — reverse of polling।", en: "Outbound HTTP POST when an event happens — reverse of polling." } },
    { term: "HMAC", definition: { bn: "Hash-based Message Authentication Code — shared secret দিয়ে payload sign।", en: "Hash-based MAC — signs a payload with a shared secret." } },
    { term: "redeliver", definition: { bn: "Failed delivery হাতে ট্রিগার করে আবার পাঠানো।", en: "Manually retrying a failed delivery." } },
  ],
};
