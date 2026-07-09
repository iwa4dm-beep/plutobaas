import { Languages } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/lib/help/locale";

// Tiny bn/en toggle used inside HelpPanel + HelpDrawer.
export function LocaleSwitch() {
  const [locale, setLocale] = useLocale();
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setLocale(locale === "bn" ? "en" : "bn")}
      className="gap-1 text-xs"
      aria-label={locale === "bn" ? "Switch to English" : "বাংলায় দেখুন"}
    >
      <Languages className="h-3.5 w-3.5" />
      {locale === "bn" ? "EN" : "বাংলা"}
    </Button>
  );
}
