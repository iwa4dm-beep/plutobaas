import type { PageHelp } from "@/lib/help/types";

// /dashboard/graphql — GraphQL explorer.
export const dashboardGraphqlHelp: PageHelp = {
  slug: "dashboard.graphql",
  page: {
    title: { bn: "GraphQL Explorer — auto-generated schema", en: "GraphQL explorer — auto-generated schema" },
    whatItDoes: {
      bn: "SQL schema থেকে auto-generate হওয়া GraphQL API এখান থেকে explore এবং test করা যায়। GraphiQL-এর মতো IDE — query, mutation, subscription সব সাপোর্ট।",
      en: "Explore and test the auto-generated GraphQL API from your SQL schema — a GraphiQL-style IDE supporting queries, mutations, and subscriptions.",
    },
    whyItMatters: {
      bn: "REST-এর পাশাপাশি GraphQL client-এর জন্য একই backend-এ single-endpoint access। Frontend developer-দের জন্য দ্রুত prototype।",
      en: "GraphQL gives clients a single-endpoint alongside REST — great for rapid frontend prototyping.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "বামে schema explorer (types, fields, args), মাঝে query editor, ডানে result panel। উপরে endpoint URL এবং auth token input।",
        en: "Schema explorer on the left (types, fields, args), query editor in the middle, results on the right; endpoint URL + auth token on top.",
      },
    },
    {
      id: "first-query",
      title: { bn: "প্রথম query চালানো", en: "Running your first query" },
      whatItDoes: {
        bn: "SQL table-এর নাম pluralize হয়ে GraphQL type হয় (users → usersCollection); primary field auto-expose হয়।",
        en: "SQL table names become GraphQL types (users → usersCollection); primary fields are auto-exposed.",
      },
      howToUse: [
        { bn: "ধাপ ১: উপরে auth token (anon/authenticated/service_role) paste করুন।", en: "Step 1: paste an auth token (anon/authenticated/service_role) on top." },
        { bn: "ধাপ ২: বাম Explorer-এ চাই সেই collection expand করুন → field-এ tick দিন → auto query তৈরি হবে।", en: "Step 2: expand the target collection in Explorer → tick fields → query auto-builds." },
        { bn: "ধাপ ৩: 'Run' (⌘/Ctrl+Enter) চাপুন।", en: "Step 3: hit 'Run' (⌘/Ctrl+Enter)." },
        { bn: "ধাপ ৪: right panel-এ JSON response দেখুন।", en: "Step 4: check JSON response on the right." },
        { bn: "ধাপ ৫: Variables tab-এ `$var` value দিন যাতে query reusable হয়।", en: "Step 5: use the Variables tab to bind `$var` values for reusable queries." },
      ],
    },
    {
      id: "mutations",
      title: { bn: "Mutation চালানো", en: "Running mutations" },
      whatItDoes: {
        bn: "insertInto, updateBy, deleteFrom mutation auto-generated। RLS policy allow করলে তবেই সফল হবে।",
        en: "insertInto, updateBy, deleteFrom mutations are auto-generated; success depends on RLS policies allowing them.",
      },
      howToUse: [
        { bn: "ধাপ ১: Docs panel-এ 'Mutation' expand → target mutation বাছাই।", en: "Step 1: expand 'Mutation' in Docs → pick a mutation." },
        { bn: "ধাপ ২: required arg fill করুন (Explorer auto-populate করে)।", en: "Step 2: fill required args (Explorer auto-populates them)." },
        { bn: "ধাপ ৩: Run — returned record দেখুন।", en: "Step 3: Run — inspect the returned record." },
      ],
    },
    {
      id: "subscriptions",
      title: { bn: "Subscription (realtime)", en: "Subscriptions (realtime)" },
      whatItDoes: {
        bn: "WebSocket-এর মাধ্যমে table change (INSERT/UPDATE/DELETE) live stream — Realtime CDC-র সাথে integrated।",
        en: "Stream table changes (INSERT/UPDATE/DELETE) live over WebSocket — integrated with Realtime CDC.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'subscription' keyword দিয়ে query লিখুন।", en: "Step 1: write a query starting with 'subscription'." },
        { bn: "ধাপ ২: Run — connection persistent থাকবে, event এলে result panel-এ append হবে।", en: "Step 2: Run — the connection stays open and events append to the result panel." },
        { bn: "ধাপ ৩: 'Stop' চাপে subscription বন্ধ করুন।", en: "Step 3: click 'Stop' to end the subscription." },
      ],
    },
    {
      id: "troubleshooting",
      title: { bn: "সাধারণ সমস্যা", en: "Common issues" },
      whatItDoes: { bn: "GraphQL-এ প্রায়ই যে error আসে।", en: "The errors you'll hit most often." },
      troubleshooting: [
        {
          problem: { bn: "'Cannot query field ... on type'", en: "'Cannot query field ... on type'" },
          solution: {
            bn: "Schema refresh লাগবে — 'Reload docs' চাপুন অথবা /dashboard/api → Refresh schema।", en: "Schema is stale — click 'Reload docs' or refresh at /dashboard/api.",
          },
        },
        {
          problem: { bn: "Empty response, no error", en: "Empty response with no error" },
          solution: { bn: "RLS filter করছে সব row — token role check করুন।", en: "RLS is filtering everything — check the token's role." },
        },
      ],
    },
  ],
  glossary: [
    { term: "collection", definition: { bn: "একটা table-এর GraphQL representation (rows list করে)।", en: "GraphQL wrapper for a table (lists rows)." } },
    { term: "subscription", definition: { bn: "Long-lived query যা event এলে auto-update হয়।", en: "A long-lived query that updates when events fire." } },
  ],
};
