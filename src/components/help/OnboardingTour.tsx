// 5-step onboarding tour. DISABLED BY DEFAULT — it never opens on its own.
//
// How to turn it on (any one of these):
//   1. Console / code:  window.plutoStartTour()
//   2. Code import:     import { startOnboardingTour } from "@/components/help/OnboardingTour"
//                       startOnboardingTour()
//   3. Persist it on:   localStorage.setItem("pluto:help:tour", "1")  → then reload
//   4. URL:             add ?tour=1 to any page
// Turn it off again:    localStorage.removeItem("pluto:help:tour")
//
// Fully bilingual; uses shadcn Dialog for the overlay.
import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/help/locale";

const KEY = "pluto:help:onboarded";
/** Opt-in switch. Absent/"0" = tour stays closed on load. */
const ENABLE_KEY = "pluto:help:tour";
const OPEN_EVENT = "pluto:help:tour:open";

/** Programmatic trigger — opens the tour immediately, from anywhere. */
export function startOnboardingTour(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}


type Step = {
  title: { bn: string; en: string };
  body: { bn: string; en: string };
  cta?: { label: { bn: string; en: string }; to: string };
};

const STEPS: Step[] = [
  {
    title: { bn: "স্বাগতম Pluto BaaS-এ!", en: "Welcome to Pluto BaaS" },
    body: {
      bn: "আপনার নিজের self-hosted backend — Auth, REST API, Storage, AI সব এক জায়গায়। এই ৫ ধাপে চিনে নিন কোথায় কী।",
      en: "Your self-hosted backend — Auth, REST API, Storage, and AI all in one place. Five quick steps to show you around.",
    },
  },
  {
    title: { bn: "ধাপ ১ — Backend verify করুন", en: "Step 1 — Verify your backend" },
    body: {
      bn: "/dashboard/verify থেকে এক ক্লিকে ১২টা health check চালান। সব ✔ হলে আপনি ready।",
      en: "Run all 12 health checks in one click from /dashboard/verify. All green = you're ready.",
    },
    cta: { label: { bn: "Verify পেইজ খুলুন", en: "Open Verify" }, to: "/dashboard/verify" },
  },
  {
    title: { bn: "ধাপ ২ — Auto REST API দেখুন", en: "Step 2 — Explore auto REST API" },
    body: {
      bn: "/dashboard/api-তে আপনার schema থেকে auto-generated endpoints, curl example, এবং typed TypeScript client পাবেন।",
      en: "See auto-generated endpoints, curl examples, and a typed TS client at /dashboard/api.",
    },
    cta: { label: { bn: "REST API দেখুন", en: "Open REST API" }, to: "/dashboard/api" },
  },
  {
    title: { bn: "ধাপ ৩ — CORS ও Audit", en: "Step 3 — CORS and Audit" },
    body: {
      bn: "Production frontend origin CORS-এ যোগ করুন, আর /dashboard/audit থেকে প্রতিটি admin action live track করুন।",
      en: "Whitelist your production origin in CORS, and live-track every admin action from /dashboard/audit.",
    },
    cta: { label: { bn: "CORS খুলুন", en: "Open CORS" }, to: "/dashboard/cors" },
  },
  {
    title: { bn: "ধাপ ৫ — Cmd+K = সাহায্য", en: "Step 5 — Cmd+K opens help" },
    body: {
      bn: "যে কোন পেইজে Cmd/Ctrl + K চেপে সাহায্য খুঁজুন। উপরের 'Beginner mode' টগল দিয়ে বিস্তারিত গাইড on/off করুন।",
      en: "Press Cmd/Ctrl + K on any page to search help. Toggle 'Beginner mode' in the header for detailed guidance.",
    },
  },
];

export function OnboardingTour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [locale] = useLocale();
  const navigate = useNavigate();

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Opt-in only: nothing pops up unless the flag, the ?tour=1 query, or a
    // programmatic trigger explicitly asks for it.
    const openNow = () => { setStep(0); setOpen(true); };
    try {
      const enabled =
        window.localStorage.getItem(ENABLE_KEY) === "1" ||
        new URLSearchParams(window.location.search).get("tour") === "1";
      if (enabled && window.localStorage.getItem(KEY) !== "1") openNow();
    } catch { /* ignore */ }

    (window as unknown as { plutoStartTour?: () => void }).plutoStartTour = () => {
      try { window.localStorage.removeItem(KEY); } catch { /* ignore */ }
      openNow();
    };
    window.addEventListener(OPEN_EVENT, openNow);
    return () => {
      window.removeEventListener(OPEN_EVENT, openNow);
      delete (window as unknown as { plutoStartTour?: () => void }).plutoStartTour;
    };
  }, []);


  function finish() {
    try { window.localStorage.setItem(KEY, "1"); } catch { /* ignore */ }
    setOpen(false);
  }

  const s = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const t = (b: { bn: string; en: string }) => (locale === "bn" ? b.bn : b.en);

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) finish(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t(s.title)}</DialogTitle>
          <DialogDescription>{t(s.body)}</DialogDescription>
        </DialogHeader>
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {step + 1} / {STEPS.length}
          </div>
          <div className="flex gap-2">
            {s.cta && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { finish(); navigate({ to: s.cta!.to }); }}
              >
                {t(s.cta.label)}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={finish}>
              {locale === "bn" ? "এড়িয়ে যান" : "Skip"}
            </Button>
            <Button
              size="sm"
              onClick={() => (isLast ? finish() : setStep(step + 1))}
            >
              {isLast
                ? (locale === "bn" ? "শেষ" : "Done")
                : (locale === "bn" ? "পরবর্তী" : "Next")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
