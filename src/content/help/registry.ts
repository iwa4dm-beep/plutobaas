// Central registry of all bilingual PageHelp objects. Powers the global
// Cmd+K help search palette. When you add a new src/content/help/<slug>.ts
// file, import + push it here so it becomes searchable.
import type { PageHelp } from "@/lib/help/types";
import { dashboardVerifyHelp } from "./dashboard.verify";
import { dashboardApiHelp } from "./dashboard.api";
import { dashboardCorsHelp } from "./dashboard.cors";
import { dashboardAuditHelp } from "./dashboard.audit";
import { dashboardAiHelp } from "./dashboard.ai";
import { dashboardIndexHelp } from "./dashboard.index";
import { dashboardPlutoAdminHelp } from "./dashboard.pluto-admin";
import { dashboardIntegrationsHelp } from "./dashboard.integrations";
import { dashboardDatabaseHelp } from "./dashboard.database";
import { dashboardDatabaseImportHelp } from "./dashboard.database-import";
import { dashboardSqlHelp } from "./dashboard.sql";
import { dashboardPlutoSchemaHelp } from "./dashboard.pluto-schema";
import { dashboardPlutoStudioHelp } from "./dashboard.pluto-studio";
import { dashboardMigrationsHelp } from "./dashboard.migrations";
import { dashboardGraphqlHelp } from "./dashboard.graphql";

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
  // Overview
  dashboardIndexHelp,
  dashboardPlutoAdminHelp,
  dashboardVerifyHelp,
  dashboardIntegrationsHelp,
  // Data
  dashboardDatabaseHelp,
  dashboardDatabaseImportHelp,
  dashboardSqlHelp,
  dashboardPlutoSchemaHelp,
  dashboardPlutoStudioHelp,
  dashboardMigrationsHelp,
  dashboardGraphqlHelp,
  dashboardApiHelp,
  // Ops
  dashboardCorsHelp,
  dashboardAuditHelp,
  dashboardAiHelp,
].map((help) => ({ help, route: slugToRoute(help.slug) }));
