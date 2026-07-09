import type { PageHelp } from "@/lib/help/types";
import { HelpPanel } from "./HelpPanel";

// Lightweight wrapper: for routes that don't yet have a full bilingual
// content file, we still get a beginner-friendly HelpPanel by synthesising
// a minimal PageHelp from the same title/description already shown in
// PageHeader. Copy editors can promote any of these into a proper file
// under src/content/help/<slug>.ts later without touching the route.
export function AutoHelpPanel({
  slug,
  title,
  description,
  titleBn,
  descriptionBn,
}: {
  slug: string;
  title: string;
  description: string;
  titleBn?: string;
  descriptionBn?: string;
}) {
  const help: PageHelp = {
    slug,
    page: {
      title: { bn: titleBn ?? title, en: title },
      whatItDoes: { bn: descriptionBn ?? description, en: description },
    },
    sections: [
      {
        id: "overview",
        title: { bn: "সংক্ষিপ্ত পরিচিতি", en: "Overview" },
        whatItDoes: { bn: descriptionBn ?? description, en: description },
      },
    ],
  };
  return <HelpPanel help={help} defaultOpen={false} />;
}
