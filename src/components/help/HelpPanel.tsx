import { useState } from "react";
import { ChevronDown, ChevronUp, BookOpen, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useBeginnerMode, useLocale, pick } from "@/lib/help/locale";
import type { PageHelp } from "@/lib/help/types";
import { HelpDrawer } from "./HelpDrawer";
import { LocaleSwitch } from "./LocaleSwitch";

// Top-of-page collapsible bilingual help card. Hidden when beginner mode is
// off, but the "Show full guide" drawer trigger is always available.
export function HelpPanel({ help, defaultOpen = true }: { help: PageHelp; defaultOpen?: boolean }) {
  const [beginner] = useBeginnerMode();
  const [locale] = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const [drawerOpen, setDrawerOpen] = useState(false);

  if (!beginner) {
    return (
      <div className="mb-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)} className="gap-1.5">
          <BookOpen className="h-3.5 w-3.5" />
          {locale === "bn" ? "সম্পূর্ণ গাইড" : "Full guide"}
        </Button>
        <HelpDrawer help={help} open={drawerOpen} onOpenChange={setDrawerOpen} />
      </div>
    );
  }

  return (
    <>
      <Collapsible open={open} onOpenChange={setOpen} className="mb-6 rounded-lg border border-primary/20 bg-primary/5">
        <div className="flex items-start justify-between gap-3 p-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-primary">
              <BookOpen className="h-3.5 w-3.5" />
              {locale === "bn" ? "এই পেইজ সম্পর্কে" : "About this page"}
            </div>
            <h2 className="mt-1 text-base font-semibold">{pick(help.page.title, locale)}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{pick(help.page.whatItDoes, locale)}</p>
          </div>
          <div className="flex items-center gap-1">
            <LocaleSwitch />
            <Button variant="ghost" size="sm" onClick={() => setDrawerOpen(true)} className="gap-1">
              <ExternalLink className="h-3.5 w-3.5" />
              {locale === "bn" ? "বিস্তারিত" : "Details"}
            </Button>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={open ? "collapse" : "expand"}>
                {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <div className="border-t border-primary/15 px-4 py-3 text-sm">
            {help.page.whyItMatters && (
              <p className="mb-3 text-muted-foreground">
                <strong className="text-foreground">{locale === "bn" ? "কেন গুরুত্বপূর্ণ: " : "Why it matters: "}</strong>
                {pick(help.page.whyItMatters, locale)}
              </p>
            )}
            {help.sections.slice(0, 3).map((s) => (
              <div key={s.id} className="mb-3 last:mb-0">
                <div className="font-medium">{pick(s.title, locale)}</div>
                <div className="text-muted-foreground">{pick(s.whatItDoes, locale)}</div>
              </div>
            ))}
            {help.sections.length > 3 && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={() => setDrawerOpen(true)}>
                {locale === "bn"
                  ? `আরও ${help.sections.length - 3}টি সেকশন দেখুন →`
                  : `Show ${help.sections.length - 3} more sections →`}
              </Button>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <HelpDrawer help={help} open={drawerOpen} onOpenChange={setDrawerOpen} />
    </>
  );
}
