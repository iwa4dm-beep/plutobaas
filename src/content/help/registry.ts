// Central registry of all bilingual PageHelp objects. Powers the global
// Cmd+K help search palette. When you add a new src/content/help/<slug>.ts
// file, import + push it here so it becomes searchable.
import type { PageHelp } from "@/lib/help/types";
import { dashboardVerifyHelp } from "./dashboard.verify";
import { dashboardApiHelp } from "./dashboard.api";
import { dashboardCorsHelp } from "./dashboard.cors";
import { dashboardAuditHelp } from "./dashboard.audit";
import { dashboardAiHelp } from "./dashboard.ai";

export type HelpEntry = {
  help: PageHelp;
  /** absolute route path the entry lives on */
  route: string;
};

// slug "dashboard.verify" → "/dashboard/verify"
function slugToRoute(slug: string): string {
  return "/" + slug.replace(/\./g, "/");
}

export const HELP_REGISTRY: HelpEntry[] = [
  dashboardVerifyHelp,
  dashboardApiHelp,
  dashboardCorsHelp,
  dashboardAuditHelp,
  dashboardAiHelp,
].map((help) => ({ help, route: slugToRoute(help.slug) }));
