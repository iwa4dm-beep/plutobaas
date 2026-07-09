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
import { dashboardVectorHelp } from "./dashboard.vector";
import { dashboardPlutoSearchHelp } from "./dashboard.pluto-search";
import { dashboardObservabilityHelp } from "./dashboard.observability";
import { dashboardLogsHelp } from "./dashboard.logs";
import { dashboardLogsExplorerHelp } from "./dashboard.logs-explorer";
import { dashboardAuditLogHelp } from "./dashboard.audit-log";
import { dashboardScalingHelp } from "./dashboard.scaling";
import { dashboardUsageHelp } from "./dashboard.usage";
import { dashboardPlutoBillingHelp } from "./dashboard.pluto-billing";
import { dashboardProjectsHelp } from "./dashboard.projects";
import { dashboardWorkspacesHelp } from "./dashboard.workspaces";
import { dashboardCustomDomainsHelp } from "./dashboard.custom-domains";
import { dashboardBackupsHelp } from "./dashboard.backups";
import { dashboardBranchingHelp } from "./dashboard.branching";
import { dashboardPlutoBranchesHelp } from "./dashboard.pluto-branches";
import { dashboardPlutoReplicasHelp } from "./dashboard.pluto-replicas";
import { dashboardPlutoComplianceHelp } from "./dashboard.pluto-compliance";
import { dashboardPlutoVaultHelp } from "./dashboard.pluto-vault";
import { dashboardEnterpriseHelp } from "./dashboard.enterprise";
import { dashboardPlutoMarketplaceHelp } from "./dashboard.pluto-marketplace";
import { dashboardPlutoBackupsHelp } from "./dashboard.pluto-backups";
import { dashboardPlutoAiHelp } from "./dashboard.pluto-ai";
import { dashboardPlutoSdkHelp } from "./dashboard.pluto-sdk";
import { dashboardSdkDemoHelp } from "./dashboard.sdk-demo";
import { dashboardDevexHelp } from "./dashboard.devex";
import { dashboardSettingsHelp } from "./dashboard.settings";
import { dashboardConnectProjectHelp } from "./dashboard.connect-project";

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
  // Storage & Files
  dashboardStorageHelp,
  dashboardPlutoStoragePlusHelp,
  // Realtime & Functions
  dashboardRealtimeHelp,
  dashboardFunctionsHelp,
  dashboardPlutoFunctionsPlusHelp,
  dashboardJobsHelp,
  dashboardPlutoQueuesHelp,
  dashboardPlutoWebhooksHelp,
  // AI & Search
  dashboardAiHelp,
  dashboardVectorHelp,
  dashboardPlutoSearchHelp,
  // Ops & Observability
  dashboardObservabilityHelp,
  dashboardLogsHelp,
  dashboardLogsExplorerHelp,
  dashboardAuditHelp,
  dashboardAuditLogHelp,
  dashboardScalingHelp,
  dashboardUsageHelp,
  dashboardPlutoBillingHelp,
  // Platform
  dashboardProjectsHelp,
  dashboardWorkspacesHelp,
  dashboardCorsHelp,
  dashboardCustomDomainsHelp,
  dashboardBackupsHelp,
  dashboardPlutoBackupsHelp,
  dashboardBranchingHelp,
  dashboardPlutoBranchesHelp,
  dashboardPlutoReplicasHelp,
  dashboardPlutoComplianceHelp,
  dashboardPlutoVaultHelp,
  dashboardEnterpriseHelp,
  dashboardPlutoMarketplaceHelp,
  // AI Gateway (separate from AI & Vector)
  dashboardPlutoAiHelp,
  // Developer
  dashboardPlutoSdkHelp,
  dashboardSdkDemoHelp,
  dashboardDevexHelp,
  dashboardSettingsHelp,
].map((help) => ({ help, route: slugToRoute(help.slug) }));
