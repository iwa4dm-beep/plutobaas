import type { PageHelp } from "@/lib/help/types";

export const dashboardAiHelp: PageHelp = {
  slug: "dashboard.ai",
  page: {
    title: { bn: "AI & Vector", en: "AI & Vector" },
    whatItDoes: {
      bn: "Embeddings, streaming chat, এবং vector search — সব Pluto এর মাধ্যমে proxy হয় যাতে আপনার frontend কোনদিন provider API key না দেখে।",
      en: "Embeddings, streaming chat, and vector search — all proxied through Pluto so your frontend never sees a provider key.",
    },
    whyItMatters: {
      bn: "API key কখনো ব্রাউজারে expose হবে না; usage log, rate limit, এবং provider swap Pluto থেকেই handle হয়।",
      en: "Provider API keys never leak to the browser; usage logging, rate limits, and provider swaps stay server-side.",
    },
  },
  sections: [
    {
      id: "status",
      title: { bn: "Gateway status", en: "Gateway status" },
      whatItDoes: {
        bn: "উপরের badge দেখায় AI gateway ready কিনা। 501 আসলে backend 16.1+ upgrade দরকার।",
        en: "The badge shows whether the AI gateway is ready. A 501 means the backend needs to be on 16.1+.",
      },
    },
    {
      id: "chat",
      title: { bn: "Chat playground", en: "Chat playground" },
      whatItDoes: {
        bn: "Prompt লিখে Send চাপুন — response stream হয়ে আসবে।",
        en: "Type a prompt and click Send — the response streams in.",
      },
      howToUse: [
        { bn: "Model select করুন (default: gemini-flash)।", en: "Pick a model (default: gemini-flash)." },
        { bn: "Prompt লিখুন।", en: "Type your prompt." },
        { bn: "Send চাপুন এবং token-by-token response দেখুন।", en: "Click Send and watch tokens stream." },
      ],
    },
    {
      id: "vector",
      title: { bn: "Vector search", en: "Vector search" },
      whatItDoes: {
        bn: "Text দিয়ে embedding তৈরি করে pgvector table-এ nearest neighbor search করা যায়।",
        en: "Generate embeddings from text and run nearest-neighbor search over a pgvector table.",
      },
    },
  ],
  glossary: [
    { term: "embedding", definition: {
      bn: "Text-এর numeric vector representation — similar text-এর embedding কাছাকাছি হয়।",
      en: "Numeric vector representation of text — similar texts have nearby embeddings.",
    }},
    { term: "pgvector", definition: {
      bn: "PostgreSQL extension যেটা vector column ও similarity search support করে।",
      en: "PostgreSQL extension that adds vector columns and similarity search.",
    }},
  ],
};
