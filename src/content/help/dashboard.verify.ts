import type { PageHelp } from "@/lib/help/types";

// Sample help content for /dashboard/verify — used as the reference template
// while filling out the remaining routes in Batches 3-4.
export const dashboardVerifyHelp: PageHelp = {
  slug: "dashboard.verify",
  page: {
    title: {
      bn: "ব্যাকএন্ড ভেরিফাই",
      en: "Backend verification",
    },
    whatItDoes: {
      bn: "এই পেইজ আপনার Pluto backend-এর ১২টি critical endpoint check করে দেখায় সব কিছু ঠিকঠাক কাজ করছে কিনা।",
      en: "This page runs 12 critical checks against your Pluto backend so you can see at a glance whether every subsystem is healthy.",
    },
    whyItMatters: {
      bn: "নতুন deploy বা secret update-এর পর একবার Run all চাপলেই বোঝা যাবে DB, storage, auth, migration সব ঠিক আছে।",
      en: "After every deploy or secret rotation, one click confirms DB, storage, auth, and migrations are all wired correctly.",
    },
  },
  sections: [
    {
      id: "run-all",
      title: { bn: "সব চেক একসাথে চালানো", en: "Run all checks" },
      whatItDoes: {
        bn: "উপরের 'Run all checks' বাটন চাপলে প্রতিটি check parallel-ভাবে চলে।",
        en: "The 'Run all checks' button at the top runs every probe in parallel.",
      },
      howToUse: [
        { bn: "'Run all checks' বাটন চাপুন।", en: "Click 'Run all checks'." },
        { bn: "প্রতিটি row-তে ✔ (pass), ✘ (fail), বা — (skipped) icon দেখুন।", en: "Watch each row for ✔ (pass), ✘ (fail), or — (skipped)." },
        { bn: "যেকোন failed row-এ hover করলে বিস্তারিত error দেখাবে।", en: "Hover a failed row for the detailed error." },
      ],
    },
    {
      id: "service-role",
      title: { bn: "Service role checks", en: "Service role checks" },
      whatItDoes: {
        bn: "যেসব check-এ 'requires service role' লেখা, সেগুলোর জন্য একটা service-role API key দরকার।",
        en: "Checks tagged 'requires service role' need a service-role API key to run.",
      },
      whenToUse: {
        bn: "Admin route (যেমন /admin/v1/migrations/last-boot) test করতে গেলে।",
        en: "Whenever you need to hit an admin route like /admin/v1/migrations/last-boot.",
      },
    },
    {
      id: "troubleshooting",
      title: { bn: "সাধারণ সমস্যা", en: "Common issues" },
      whatItDoes: {
        bn: "যদি অনেকগুলো check ফেল করে, নিচের গাইড দেখুন।",
        en: "When several checks fail at once, walk this list first.",
      },
      troubleshooting: [
        {
          problem: { bn: "সব check offline দেখাচ্ছে", en: "Every check shows offline" },
          solution: {
            bn: "PLUTO_UPSTREAM_URL secret set আছে কিনা check করুন; backend restart করুন।",
            en: "Confirm the PLUTO_UPSTREAM_URL secret is set and the backend is running.",
          },
        },
        {
          problem: { bn: "401 Unauthorized আসছে", en: "401 Unauthorized on admin checks" },
          solution: {
            bn: "Service role key valid নয় বা expire করেছে; /dashboard/api থেকে নতুন key issue করুন।",
            en: "The service-role key is invalid or expired — issue a new one from /dashboard/api.",
          },
        },
      ],
    },
  ],
  glossary: [
    {
      term: "readyz",
      definition: {
        bn: "Kubernetes-style readiness probe — backend request নিতে প্রস্তুত কিনা জানায়।",
        en: "Kubernetes-style readiness probe — tells you whether the backend is ready to accept requests.",
      },
    },
    {
      term: "service role",
      definition: {
        bn: "সর্বোচ্চ privilege-এর API key, শুধু admin কাজে ব্যবহৃত।",
        en: "The highest-privilege API key, used only for admin operations.",
      },
    },
  ],
};
