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
import { dashboardUsersHelp } from "./dashboard.users";
import { dashboardMfaHelp } from "./dashboard.mfa";
import { dashboardPlutoAuthAdvancedHelp } from "./dashboard.pluto-auth-advanced";
import { dashboardPlutoOrgsHelp } from "./dashboard.pluto-orgs";
import { dashboardRbacHelp } from "./dashboard.rbac";
import { dashboardTokensHelp } from "./dashboard.tokens";
import { dashboardStorageHelp } from "./dashboard.storage";
import { dashboardPlutoStoragePlusHelp } from "./dashboard.pluto-storage-plus";
import { dashboardRealtimeHelp } from "./dashboard.realtime";
import { dashboardFunctionsHelp } from "./dashboard.functions";
import { dashboardPlutoFunctionsPlusHelp } from "./dashboard.pluto-functions-plus";
import { dashboardJobsHelp } from "./dashboard.jobs";
import { dashboardPlutoQueuesHelp } from "./dashboard.pluto-queues";
import { dashboardPlutoWebhooksHelp } from "./dashboard.pluto-webhooks";

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
  // Auth & Users
  dashboardUsersHelp,
  dashboardMfaHelp,
  dashboardPlutoAuthAdvancedHelp,
  dashboardPlutoOrgsHelp,
  dashboardRbacHelp,
  dashboardTokensHelp,
  // Ops
  dashboardCorsHelp,
  dashboardAuditHelp,
  dashboardAiHelp,
].map((help) => ({ help, route: slugToRoute(help.slug) }));
