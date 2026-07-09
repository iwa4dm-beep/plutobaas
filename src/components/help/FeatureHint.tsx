import { HelpCircle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useBeginnerMode, useLocale, pick } from "@/lib/help/locale";
import type { Bilingual } from "@/lib/help/types";

// Small (?) icon next to a button/field. Popover shows bilingual short text.
// Always renders — beginner mode only affects auto-open behavior.
export function FeatureHint({
  text,
  className,
  size = "sm",
}: {
  text: Bilingual;
  className?: string;
  size?: "sm" | "md";
}) {
  const [locale] = useLocale();
  const [beginner] = useBeginnerMode();
  const iconClass = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={locale === "bn" ? "সাহায্য" : "Help"}
          className={`inline-flex items-center rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground ${
            beginner ? "text-primary/70" : ""
          } ${className ?? ""}`}
        >
          <HelpCircle className={iconClass} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" className="max-w-xs text-sm">
        {pick(text, locale)}
      </PopoverContent>
    </Popover>
  );
}
