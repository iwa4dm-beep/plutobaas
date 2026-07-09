// Bilingual help-content schema shared by HelpPanel / HelpDrawer / FeatureHint.
// One content file per route lives under src/content/help/<slug>.ts and exports
// a `PageHelp` object matching this shape. Copy-only files — never import
// runtime components here, so the schema stays edit-friendly for non-devs.

export type Locale = "bn" | "en";

export type Bilingual = { bn: string; en: string };

export type HelpStep = {
  /** short imperative sentence: "Click Generate" / "Generate চাপুন" */
  bn: string;
  en: string;
  /** optional inline note or gotcha */
  note?: Bilingual;
};

export type HelpField = {
  /** field label as it appears in UI */
  name: string;
  purpose: Bilingual;
  example?: string;
};

export type HelpTrouble = {
  problem: Bilingual;
  solution: Bilingual;
};

export type HelpSection = {
  id: string;
  title: Bilingual;
  whatItDoes: Bilingual;
  /** optional — when this section is useful */
  whenToUse?: Bilingual;
  howToUse?: HelpStep[];
  fields?: HelpField[];
  troubleshooting?: HelpTrouble[];
};

export type HelpGlossary = {
  term: string;
  definition: Bilingual;
};

export type PageHelp = {
  /** route slug, e.g. "dashboard.verify" */
  slug: string;
  page: {
    title: Bilingual;
    whatItDoes: Bilingual;
    whyItMatters?: Bilingual;
  };
  sections: HelpSection[];
  glossary?: HelpGlossary[];
};
