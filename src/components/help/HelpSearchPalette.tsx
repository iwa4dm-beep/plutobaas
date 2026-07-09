// Global Cmd+K (Ctrl+K on Windows/Linux) help search palette. Searches
// across every registered PageHelp — title, section titles, and glossary
// terms — and navigates to the matching route.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { HELP_REGISTRY, type HelpEntry } from "@/content/help/registry";
import { useLocale, pick } from "@/lib/help/locale";

type Hit = {
  entry: HelpEntry;
  matched: string;
  kind: "page" | "section" | "glossary";
};

function search(q: string, locale: "bn" | "en"): Hit[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const out: Hit[] = [];
  for (const entry of HELP_REGISTRY) {
    const t = pick(entry.help.page.title, locale).toLowerCase();
    if (t.includes(needle)) {
      out.push({ entry, matched: pick(entry.help.page.title, locale), kind: "page" });
    }
    for (const s of entry.help.sections) {
      const st = pick(s.title, locale).toLowerCase();
      if (st.includes(needle)) {
        out.push({ entry, matched: pick(s.title, locale), kind: "section" });
      }
    }
    for (const g of entry.help.glossary ?? []) {
      if (g.term.toLowerCase().includes(needle) ||
          pick(g.definition, locale).toLowerCase().includes(needle)) {
        out.push({ entry, matched: g.term, kind: "glossary" });
      }
    }
  }
  return out.slice(0, 20);
}

export function HelpSearchPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [locale] = useLocale();
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hits = useMemo(() => search(q, locale), [q, locale]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-xl p-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={locale === "bn" ? "সাহায্য খুঁজুন… (Cmd+K)" : "Search help… (Cmd+K)"}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-2">
          {q.trim() === "" && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {locale === "bn"
                ? "যে কোন feature বা term লিখুন — যেমন 'CORS', 'audit', 'embedding'।"
                : "Type any feature or term — try 'CORS', 'audit', 'embedding'."}
            </div>
          )}
          {q.trim() !== "" && hits.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {locale === "bn" ? "কিছু পাওয়া যায়নি।" : "No matches."}
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={i}
              onClick={() => {
                setOpen(false);
                setQ("");
                navigate({ to: h.entry.route });
              }}
              className="flex w-full items-start gap-3 px-4 py-2 text-left hover:bg-accent"
            >
              <span className="mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                {h.kind}
              </span>
              <span className="flex-1">
                <div className="text-sm font-medium">{h.matched}</div>
                <div className="text-xs text-muted-foreground">
                  {pick(h.entry.help.page.title, locale)} · {h.entry.route}
                </div>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
