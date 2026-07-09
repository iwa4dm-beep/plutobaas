import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useLocale, pick } from "@/lib/help/locale";
import type { PageHelp } from "@/lib/help/types";
import { LocaleSwitch } from "./LocaleSwitch";

// Full documentation drawer — every section, field, and troubleshooting item
// rendered as plain scrollable content. Users open it from HelpPanel.
export function HelpDrawer({
  help,
  open,
  onOpenChange,
}: {
  help: PageHelp;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [locale] = useLocale();

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader className="mb-4">
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{pick(help.page.title, locale)}</SheetTitle>
            <LocaleSwitch />
          </div>
          <SheetDescription>{pick(help.page.whatItDoes, locale)}</SheetDescription>
        </SheetHeader>

        {help.page.whyItMatters && (
          <div className="mb-6 rounded-md border border-border bg-muted/40 p-3 text-sm">
            <strong>{locale === "bn" ? "কেন গুরুত্বপূর্ণ: " : "Why it matters: "}</strong>
            {pick(help.page.whyItMatters, locale)}
          </div>
        )}

        <div className="space-y-6 pb-8">
          {help.sections.map((s) => (
            <section key={s.id} className="space-y-2">
              <h3 className="text-base font-semibold">{pick(s.title, locale)}</h3>
              <p className="text-sm text-muted-foreground">{pick(s.whatItDoes, locale)}</p>

              {s.whenToUse && (
                <p className="text-sm">
                  <strong>{locale === "bn" ? "কখন ব্যবহার: " : "When to use: "}</strong>
                  {pick(s.whenToUse, locale)}
                </p>
              )}

              {s.howToUse && s.howToUse.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase text-muted-foreground">
                    {locale === "bn" ? "ধাপসমূহ" : "Steps"}
                  </div>
                  <ol className="list-decimal space-y-1 pl-5 text-sm">
                    {s.howToUse.map((step, i) => (
                      <li key={i}>
                        {pick(step, locale)}
                        {step.note && (
                          <div className="text-xs text-muted-foreground">— {pick(step.note, locale)}</div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {s.fields && s.fields.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase text-muted-foreground">
                    {locale === "bn" ? "ফিল্ড" : "Fields"}
                  </div>
                  <ul className="space-y-1 text-sm">
                    {s.fields.map((f) => (
                      <li key={f.name}>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{f.name}</code>
                        <span className="ml-2 text-muted-foreground">{pick(f.purpose, locale)}</span>
                        {f.example && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            ({locale === "bn" ? "উদাহরণ" : "example"}: <code>{f.example}</code>)
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {s.troubleshooting && s.troubleshooting.length > 0 && (
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase text-muted-foreground">
                    {locale === "bn" ? "সমস্যা সমাধান" : "Troubleshooting"}
                  </div>
                  <ul className="space-y-1 text-sm">
                    {s.troubleshooting.map((t, i) => (
                      <li key={i} className="rounded border border-border p-2">
                        <div>
                          <strong>{locale === "bn" ? "সমস্যা: " : "Problem: "}</strong>
                          {pick(t.problem, locale)}
                        </div>
                        <div>
                          <strong>{locale === "bn" ? "সমাধান: " : "Fix: "}</strong>
                          {pick(t.solution, locale)}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          ))}

          {help.glossary && help.glossary.length > 0 && (
            <section>
              <h3 className="mb-2 text-base font-semibold">
                {locale === "bn" ? "শব্দকোষ" : "Glossary"}
              </h3>
              <dl className="space-y-2 text-sm">
                {help.glossary.map((g) => (
                  <div key={g.term}>
                    <dt className="font-medium">{g.term}</dt>
                    <dd className="text-muted-foreground">{pick(g.definition, locale)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
