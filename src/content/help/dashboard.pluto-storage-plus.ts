import type { PageHelp } from "@/lib/help/types";

// /dashboard/pluto-storage-plus — Storage v2 (policies, resumable upload, image transforms, lifecycle).
export const dashboardPlutoStoragePlusHelp: PageHelp = {
  slug: "dashboard.pluto-storage-plus",
  page: {
    title: { bn: "Storage v2 — policy, resumable, transform", en: "Storage v2 — policies, resumable, transforms" },
    whatItDoes: {
      bn: "Storage-এর advanced feature: per-bucket access policy, resumable/multipart upload, image transform (resize/quality/format), lifecycle rule (expire/tier/abort), এবং versioning/retention control।",
      en: "Advanced Storage: per-bucket policies, resumable/multipart upload, on-the-fly image transforms (resize/quality/format), lifecycle rules (expire/tier/abort), and versioning/retention.",
    },
    whyItMatters: {
      bn: "Production-এ 5 GB+ ফাইল, image CDN, cold-storage tiering, legal-hold — এসব v1 bucket UI-তে নেই। v2 এগুলো এক জায়গায় manage করতে দেয়।",
      en: "Production needs — 5 GB+ files, image CDN, cold-storage tiering, legal holds — aren't in the v1 UI. v2 puts them in one place.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "Tab: Policies · Resumable uploads · Image transforms · Lifecycle · Versions & retention। প্রতিটা tab-এ list + create form।",
        en: "Tabs: Policies · Resumable uploads · Image transforms · Lifecycle · Versions & retention. Each tab has a list plus a create form.",
      },
    },
    {
      id: "policies",
      title: { bn: "Bucket policy", en: "Bucket policies" },
      howToUse: [
        { bn: "ধাপ ১: bucket বাছাই → 'Add policy'।", en: "Step 1: pick a bucket → 'Add policy'." },
        { bn: "ধাপ ২: role (anon/authenticated/service_role), action (read/write/delete), path prefix দিন।", en: "Step 2: enter role (anon/authenticated/service_role), action (read/write/delete), and path prefix." },
        { bn: "ধাপ ৩: Save → test করুন signed URL / anon fetch দিয়ে।", en: "Step 3: Save, then test with a signed URL / anon fetch." },
      ],
    },
    {
      id: "resumable",
      title: { bn: "Resumable / multipart upload", en: "Resumable / multipart upload" },
      whatItDoes: {
        bn: "5 GB-এর বেশি ফাইল বা flaky network-এ বড় ফাইল রেজিউম করতে হয়। এখানে চলমান session, parts (1..N), completion state দেখা যায়।",
        en: "For files over 5 GB or big uploads on flaky networks. Shows active sessions, parts (1..N), and completion state.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'New session' → bucket/key/content-type দিন।", en: "Step 1: 'New session' → bucket, key, content-type." },
        { bn: "ধাপ ২: SDK দিয়ে parts PUT করুন; UI-তে progress দেখবেন।", en: "Step 2: PUT parts from the SDK; watch progress in the UI." },
        { bn: "ধাপ ৩: সব parts হলে 'Complete' — অথবা atob abandoned session-এ 'Abort'।", en: "Step 3: 'Complete' when all parts land — or 'Abort' abandoned sessions." },
      ],
    },
    {
      id: "transforms",
      title: { bn: "Image transform (render URL)", en: "Image transforms (render URL)" },
      whatItDoes: {
        bn: "`/storage/v3/render/:bucket/*?w=&h=&fit=&quality=&format=` — CDN-cached responsive image serve। Cache key deterministic, তাই একই variant repeat request-এ hit।",
        en: "`/storage/v3/render/:bucket/*?w=&h=&fit=&quality=&format=` — CDN-cached responsive images. Deterministic cache key, so repeats hit the edge.",
      },
      howToUse: [
        { bn: "ধাপ ১: 'Preview transform' → source bucket/key ও width/height/format দিন।", en: "Step 1: 'Preview transform' → source bucket/key + width/height/format." },
        { bn: "ধাপ ২: rendered URL copy করে `<img src>`-এ দিন।", en: "Step 2: copy the rendered URL into `<img src>`." },
      ],
    },
    {
      id: "lifecycle",
      title: { bn: "Lifecycle rule", en: "Lifecycle rules" },
      whatItDoes: {
        bn: "Bucket-এর prefix-এ বয়স/state ভিত্তিক rule: `expire` (auto-delete), `tier` (cold storage), `abort_incomplete` (unfinished multipart clean-up)। 'Dry-run' দিয়ে আগে check করুন।",
        en: "Age/state rules per prefix: `expire` (auto-delete), `tier` (cold storage), `abort_incomplete` (kill stale multiparts). Use 'Dry-run' first.",
      },
      troubleshooting: [
        { problem: { bn: "Rule চললো কিন্তু object delete হয়নি", en: "Rule ran but object survived" }, solution: { bn: "Retention lock (governance/compliance/legal-hold) সেট আছে কিনা দেখুন — এগুলো priority বেশি।", en: "Check for a retention lock (governance/compliance/legal-hold) — those override lifecycle." } },
      ],
    },
    {
      id: "versions",
      title: { bn: "Versions & retention", en: "Versions & retention" },
      whatItDoes: {
        bn: "Object versioning ও immutable retention (governance/compliance/legal-hold), plus cross-region replication job status।",
        en: "Object versioning + immutable retention (governance/compliance/legal-hold) plus cross-region replication job status.",
      },
      howToUse: [
        { bn: "ধাপ ১: object-এ 'History' → version list দেখুন; পুরনো version restore/delete করুন।", en: "Step 1: 'History' on an object shows versions — restore or delete older ones." },
        { bn: "ধাপ ২: 'Set retention' → mode + retain-until দিন।", en: "Step 2: 'Set retention' → mode + retain-until." },
        { bn: "ধাপ ৩: legal hold clear করতে হলে 'Clear legal hold' (audit trail-এ log হবে)।", en: "Step 3: use 'Clear legal hold' to release one (audit-logged)." },
      ],
    },
  ],
  glossary: [
    { term: "multipart", definition: { bn: "বড় object কে ছোট parts-এ upload করে শেষে concat করা।", en: "Uploading large objects as parts and concatenating on completion." } },
    { term: "governance / compliance lock", definition: { bn: "Retention mode: governance override করা যায়, compliance পুরোপুরি immutable।", en: "Retention mode — governance is overridable, compliance is fully immutable." } },
    { term: "lifecycle", definition: { bn: "Automatic policy যা object-কে age/prefix ভিত্তিতে expire/tier করে।", en: "Automatic policy that expires or tiers objects by age/prefix." } },
  ],
};
