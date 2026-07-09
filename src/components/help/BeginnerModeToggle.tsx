import { GraduationCap } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useBeginnerMode, useLocale } from "@/lib/help/locale";

// Global toggle — recommended placement is the dashboard top bar / header.
// When OFF, HelpPanel collapses to a single "Full guide" button, so users
// keep the drawer without the always-visible bilingual card.
export function BeginnerModeToggle({ compact = false }: { compact?: boolean }) {
  const [on, setOn] = useBeginnerMode();
  const [locale] = useLocale();
  const label = locale === "bn" ? "শিক্ষানবিস মোড" : "Beginner mode";
  return (
    <div className="flex items-center gap-2">
      <GraduationCap className="h-4 w-4 text-muted-foreground" />
      {!compact && <Label htmlFor="beginner-mode" className="cursor-pointer text-sm">{label}</Label>}
      <Switch id="beginner-mode" checked={on} onCheckedChange={setOn} aria-label={label} />
    </div>
  );
}
