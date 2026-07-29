/**
 * Step-by-step explainer for the Pluto Migrator, rendered on the
 * Marketplace & Extensions page.
 */
export function MigratorGuide() {
  const steps: Array<{ title: string; body: string; detail?: string[] }> = [
    {
      title: "১. Chrome এক্সটেনশন ইনস্টল ও লগইন",
      body:
        "Pluto Collector এক্সটেনশনটি ইনস্টল করে আপনার GitHub, Supabase এবং Lovable ড্যাশবোর্ডে সাধারণভাবে লগইন থাকুন। এক্সটেনশন আপনার পাসওয়ার্ড পড়ে না — শুধু ইতিমধ্যে লগইন করা পেজ থেকে পাবলিক মেটাডেটা সংগ্রহ করে।",
      detail: [
        "Lovable → প্রজেক্টের connected repo লিংক",
        "GitHub → রিপোর্জিটরির zipball (source snapshot) URL",
        "Supabase → schema/table/view-এর SQL definition",
      ],
    },
    {
      title: "২. Collect চাপলে payload তৈরি হয়",
      body:
        "এক্সটেনশন সংগৃহীত তথ্য একটি JSON payload-এ সাজায়, তাতে timestamp ও nonce বসায় এবং আপনার শেয়ার করা secret দিয়ে HMAC-SHA256 signature তৈরি করে।",
    },
    {
      title: "৩. Signed webhook → Pluto",
      body:
        "Payload টি POST হয় /api/public/pluto-import এ। Pluto signature যাচাই করে, replay (পুরনো timestamp/duplicate nonce) আটকায়, তারপর admin.import_jobs টেবিলে একটি নতুন job সারি তৈরি করে।",
    },
    {
      title: "৪. Translate — Supabase SQL → Pluto DDL",
      body:
        "সংগৃহীত dump কে Pluto-এর DDL-এ রূপান্তর করা হয়: auth.uid() shim, RLS policy, storage bucket, extension এবং role mapping সহ। এই ধাপে কিছুই ডাটাবেজে লেখা হয় না।",
    },
    {
      title: "৫. Object নির্বাচন",
      body:
        "নিচের Migrator প্যানেলে schema / table / view-এর চেকলিস্ট দেখাবে। অপ্রয়োজনীয় object আনচেক করে দিলে সেগুলো generated SQL থেকে বাদ যাবে।",
    },
    {
      title: "৬. Dry-run ও SQL diff",
      body:
        "Dry-run মোডে কোনো পরিবর্তন প্রয়োগ হয় না — বদলে CREATE / ALTER / DROP অনুযায়ী শ্রেণিবদ্ধ একটি diff দেখানো হয়, যেখানে destructive statement আলাদা করে হাইলাইট করা থাকে।",
    },
    {
      title: "৭. Apply (রিয়েল-টাইম প্রগ্রেস)",
      body:
        "Apply চাপলে SQL এক ট্রানজেকশনে চলে। প্রতিটি ধাপ SSE (/api/import-events/:jobId) দিয়ে লাইভ স্ট্রিম হয়, তাই timeline সঙ্গে সঙ্গে আপডেট হয়। প্রতিটি version-এর SQL স্ন্যাপশট অপরিবর্তনীয়ভাবে আর্কাইভ হয়।",
    },
    {
      title: "৮. স্বয়ংক্রিয় verification",
      body:
        "Apply সফল হলে smoke test / integrity check চলে — object আছে কি না, RLS enabled কি না, row count, constraint ইত্যাদি। প্রতিটি run আর্কাইভ হয়, এবং দুটি run-এর মধ্যে diff দেখা যায়।",
    },
    {
      title: "৯. Webhook নোটিফিকেশন",
      body:
        "import.applied, import.apply_failed এবং import.verification_failed ইভেন্টে আপনার দেওয়া URL-এ HMAC-signed payload যায়। প্রতিটি চেষ্টার ফলাফলও audit history-তে লেখা থাকে।",
    },
    {
      title: "১০. রিপোর্ট ও শেয়ার লিংক",
      body:
        "প্রতিটি job-এর জন্য JSON বা প্রিন্ট-রেডি PDF রিপোর্ট (SQL version, diff, ধাপভিত্তিক error, timeline সহ) ডাউনলোড করা যায়, অথবা ১৫ মিনিট–৩০ দিন মেয়াদের signed share link তৈরি করা যায়।",
    },
  ];

  return (
    <section className="border rounded-lg p-4 space-y-4">
      <div>
        <h2 className="font-medium">Pluto Migrator কীভাবে কাজ করে</h2>
        <p className="text-sm text-muted-foreground">
          GitHub / Supabase / Lovable থেকে প্রজেক্ট ও ডাটাবেজ Pluto-তে আনার সম্পূর্ণ ধারাবাহিক প্রবাহ।
        </p>
      </div>

      <ol className="space-y-3">
        {steps.map((s, i) => (
          <li key={i} className="relative pl-8">
            <span className="absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
              {i + 1}
            </span>
            <div className="text-sm font-medium">{s.title}</div>
            <p className="text-sm text-muted-foreground">{s.body}</p>
            {s.detail && (
              <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                {s.detail.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ol>

      <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground space-y-1">
        <div className="font-medium text-foreground">মনে রাখবেন</div>
        <div>• Dry-run না দেখে সরাসরি Apply করবেন না — DROP statement থাকলে ডেটা হারাতে পারে।</div>
        <div>• Import শুরুর আগে target প্রজেক্টের একটি backup নিন (Ops পেজ থেকে)।</div>
        <div>• Verification fail হলে job rollback হয় না — timeline-এর error দেখে ঠিক করে Retry দিন।</div>
      </div>
    </section>
  );
}
