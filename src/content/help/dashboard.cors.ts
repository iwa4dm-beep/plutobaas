import type { PageHelp } from "@/lib/help/types";

export const dashboardCorsHelp: PageHelp = {
  slug: "dashboard.cors",
  page: {
    title: { bn: "CORS হোয়াইটলিস্ট", en: "CORS whitelist" },
    whatItDoes: {
      bn: "কোন কোন ওয়েব origin ব্রাউজার থেকে আপনার API call করতে পারবে সেটা এখানে manage করা হয়।",
      en: "Controls which browser origins are allowed to call your API.",
    },
    whyItMatters: {
      bn: "CORS ঠিক না থাকলে production ফ্রন্টএন্ড থেকে API call fail করবে (browser এ 'CORS policy' error)।",
      en: "Without correct CORS entries, production frontends fail with a 'blocked by CORS policy' error in the browser.",
    },
  },
  sections: [
    {
      id: "add",
      title: { bn: "নতুন origin যোগ", en: "Add an origin" },
      whatItDoes: {
        bn: "আপনার production ডোমেইন (যেমন https://app.example.com) input-এ লিখে Add চাপুন।",
        en: "Type your production domain (e.g. https://app.example.com) and click Add.",
      },
      howToUse: [
        { bn: "সম্পূর্ণ URL লিখুন — scheme (https://) সহ, শেষে slash ছাড়া।", en: "Enter the full URL including https://, without a trailing slash." },
        { bn: "ঐচ্ছিক note দিন যাতে পরে বোঝা যায় কোন app এটা।", en: "Add an optional note so future-you remembers which app this is." },
        { bn: "Add চাপুন — সাথে সাথে effective হবে।", en: "Click Add — the rule takes effect immediately." },
      ],
      fields: [
        { name: "origin", purpose: { bn: "যে ডোমেইন allow করবেন", en: "The domain to allow" }, example: "https://app.example.com" },
        { name: "note",   purpose: { bn: "মনে রাখার জন্য description", en: "Human-readable description" } },
      ],
    },
    {
      id: "localhost",
      title: { bn: "Localhost", en: "Localhost" },
      whatItDoes: {
        bn: "Dev environment-এ localhost auto allow করা থাকে — আলাদা যোগ করতে হবে না।",
        en: "Localhost is auto-allowed in dev — no manual entry needed.",
      },
    },
    {
      id: "trouble",
      title: { bn: "সাধারণ সমস্যা", en: "Common issues" },
      whatItDoes: { bn: "CORS error debug করার সময় এগুলো দেখুন।", en: "Walk this list when debugging a CORS error." },
      troubleshooting: [
        {
          problem: { bn: "Origin add করার পরও blocked", en: "Still blocked after adding origin" },
          solution: {
            bn: "URL exact match হতে হবে — https এবং http আলাদা, subdomain-ও আলাদা। browser hard-refresh করুন।",
            en: "URLs must match exactly — https vs http differ, subdomains differ. Hard-refresh the browser.",
          },
        },
      ],
    },
  ],
};
