import type { PageHelp } from "@/lib/help/types";

// /dashboard/storage — buckets + object browser (Storage v1).
export const dashboardStorageHelp: PageHelp = {
  slug: "dashboard.storage",
  page: {
    title: { bn: "Storage — bucket ও file management", en: "Storage — buckets & files" },
    whatItDoes: {
      bn: "Public বা private bucket তৈরি, ফাইল আপলোড/ডাউনলোড/ডিলিট, এবং signed URL ইস্যু — সব এক জায়গায়। প্রতিটি bucket-এ file-size limit ও allowed MIME type সেট করা যায়।",
      en: "Create public or private buckets, upload/download/delete files, and mint signed URLs. Each bucket supports a size limit and allowed MIME list.",
    },
    whyItMatters: {
      bn: "User-generated content (avatar, attachment, product image, PDF) কোথাও তো রাখতে হবে। এখানে ফাইল রাখলে RLS-এর মতোই policy দিয়ে access control হয়, আলাদা S3 account লাগে না।",
      en: "User content (avatars, attachments, product images, PDFs) needs a home. Files here inherit policy-based access control just like RLS — no extra S3 account required.",
    },
  },
  sections: [
    {
      id: "brief",
      title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Quick summary" },
      whatItDoes: {
        bn: "বাঁ পাশে bucket list, ডান পাশে selected bucket-এর ফাইল ব্রাউজার। উপরে '+ New bucket' ও 'Upload' বাটন।",
        en: "Left pane: bucket list. Right pane: file browser for the selected bucket. Top actions: '+ New bucket' and 'Upload'.",
      },
    },
    {
      id: "create-bucket",
      title: { bn: "Bucket তৈরি", en: "Creating a bucket" },
      howToUse: [
        { bn: "ধাপ ১: '+ New bucket' চাপুন।", en: "Step 1: click '+ New bucket'." },
        { bn: "ধাপ ২: unique নাম দিন (lowercase, hyphen; যেমন `user-avatars`)।", en: "Step 2: pick a unique name (lowercase, hyphens — e.g. `user-avatars`)." },
        { bn: "ধাপ ৩: Public/Private টগল করুন — public হলে URL জানা যে-কেউ read করতে পারবে।", en: "Step 3: toggle Public/Private — public means anyone with the URL can read." },
        { bn: "ধাপ ৪: size limit ও allowed MIME type সেট করুন (optional কিন্তু recommend)।", en: "Step 4: set size limit and allowed MIME types (optional but recommended)." },
        { bn: "ধাপ ৫: 'Create' চাপুন। এরপর bucket left list-এ চলে আসবে।", en: "Step 5: click 'Create' — the bucket appears in the left list." },
      ],
    },
    {
      id: "upload",
      title: { bn: "ফাইল আপলোড ও signed URL", en: "Upload & signed URLs" },
      howToUse: [
        { bn: "ধাপ ১: bucket বাছাই → 'Upload' চাপুন → ফাইল drop/select।", en: "Step 1: pick a bucket → 'Upload' → drop or select the file." },
        { bn: "ধাপ ২: আপলোড হলে row থেকে 'Copy URL' (public) বা 'Signed URL' (private) নিন।", en: "Step 2: after upload, use 'Copy URL' (public) or 'Signed URL' (private) from the row." },
        { bn: "ধাপ ৩: signed URL-এর expiry defaults 1 hour; দরকারে code থেকে অন্য value দিন।", en: "Step 3: signed URL expiry defaults to 1 hour; pass a custom value from code if needed." },
      ],
      troubleshooting: [
        { problem: { bn: "413 / file too large", en: "413 / file too large" }, solution: { bn: "Bucket edit করে size limit বাড়ান বা ছোট ফাইল দিন।", en: "Edit the bucket to raise the size limit, or upload a smaller file." } },
        { problem: { bn: "MIME type reject", en: "MIME type rejected" }, solution: { bn: "Bucket-এর `allowed_mime_types`-এ MIME যোগ করুন।", en: "Add the MIME to the bucket's `allowed_mime_types`." } },
        { problem: { bn: "Signed URL 403", en: "Signed URL returns 403" }, solution: { bn: "Expiry পার হয়ে গেছে — নতুন করে issue করুন।", en: "The URL expired — mint a fresh one." } },
      ],
    },
  ],
  glossary: [
    { term: "bucket", definition: { bn: "ফাইলের namespace — একটা bucket একটা folder-এর মতো।", en: "A namespace for files — like a top-level folder." } },
    { term: "signed URL", definition: { bn: "সময়সীমাযুক্ত (expiring) URL যা private ফাইল read/write করতে দেয়।", en: "A time-bound URL granting read/write on a private object." } },
    { term: "public bucket", definition: { bn: "যার সব object URL জানলেই read করা যায়।", en: "Bucket whose objects are readable by anyone with the URL." } },
  ],
};
