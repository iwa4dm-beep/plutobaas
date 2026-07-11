// Package the rewritten frontend + generated SQL into downloadable ZIPs.
import JSZip from "jszip";
import type { AnalyzeResult, DbConfig, IntegrationPlan } from "./types";
import { buildMigrationBundle } from "./migration-converter";
import { rewriteFrontend } from "./frontend-rewriter";
import { buildApplyScript, buildRollbackScript, buildRestoreReadme } from "./restore-pack";
import { mapEnv, buildEnvTemplate, buildInstallSecretsScript } from "./env-mapper";
import { buildStructureReport } from "./structure-report";
import { buildDbConfigTs } from "./db-wizard.functions";
import { mysqlToPg } from "./mysql-to-pg";

export async function buildBundle(
  originalZip: JSZip,
  analyze: AnalyzeResult,
  plan: IntegrationPlan,
  db?: DbConfig,
): Promise<{ frontend: Blob; migrations: Blob; report: Blob }> {
  const tables = plan.tables.length
    ? plan.tables.map((t) => ({ name: t.name, columns: t.columns, timestamps: true }))
    : analyze.backend.tables;

  let sql = buildMigrationBundle(tables);
  if (db?.driver === "mysql") sql = mysqlToPg(sql);

  const { zip: rewritten } = await rewriteFrontend(originalZip, analyze);

  const { entries, unknown } = mapEnv(analyze.backend.envExample);
  const envTemplate = buildEnvTemplate(entries, unknown);

  const migZip = new JSZip();
  migZip.file("001_pluto_auto.sql", sql);
  migZip.file("apply.sh", buildApplyScript({ db: db?.url ?? "postgres://user:pass@host:5432/pluto" }));
  migZip.file("rollback.sh", buildRollbackScript());
  migZip.file("pluto.env.template", envTemplate);
  migZip.file("install-secrets.sh", buildInstallSecretsScript());
  migZip.file("pluto.db.config.ts", buildDbConfigTs(db?.driver ?? "postgres", db?.url ?? ""));
  migZip.file("STRUCTURE_REPORT.md", buildStructureReport(analyze));
  migZip.file("README.md", buildRestoreReadme());

  return {
    frontend: await rewritten.generateAsync({ type: "blob", compression: "DEFLATE" }),
    migrations: await migZip.generateAsync({ type: "blob", compression: "DEFLATE" }),
    report: new Blob([buildReport(analyze, plan, db)], { type: "text/markdown" }),
  };
}

function buildReport(a: AnalyzeResult, p: IntegrationPlan, db?: DbConfig): string {
  return `# Integration Report

Generated: ${new Date().toISOString()}

## Summary
- Files scanned: ${a.stats.totalFiles} (used: ${a.stats.usedFiles})
- Tables planned: ${p.tables.length}
- Endpoints mapped: ${p.endpoints.length}
- Frontend rewrites: ${p.frontendRewrites.length}
- Risks: ${p.risks.length}
- DB: ${db ? `${db.driver} — ${db.host ?? "?"}:${db.port ?? "?"}/${db.database ?? "?"}` : "not configured"}

## Tables
${p.tables.map((t) => `- **${t.name}** — ${t.columns.length} cols, RLS: ${t.rls}`).join("\n") || "- none"}

## Endpoints
${p.endpoints.slice(0, 40).map((e) => `- \`${e.laravel}\` → \`${e.pluto}\` (${e.kind})`).join("\n") || "- none"}

## Risks
${p.risks.map((r) => `- **[${r.severity.toUpperCase()}]** ${r.message}`).join("\n") || "- none"}

## Bundle Contents (pluto-migrations.zip)
- \`001_pluto_auto.sql\` — schema + GRANTs + RLS + owner policies
- \`apply.sh\` — one-click apply with auto-rollback on failure
- \`rollback.sh\` — manual rollback to last snapshot
- \`pluto.env.template\` — systemd-compatible env template
- \`install-secrets.sh\` — auto-generate + install secrets
- \`pluto.db.config.ts\` — DB driver config (${db?.driver ?? "postgres"})
- \`STRUCTURE_REPORT.md\` — file-level scan report
`;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
