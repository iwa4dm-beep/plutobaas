// Build a structure report markdown for the analyzed project.
import type { AnalyzeResult, FileNode } from "./types";

export function groupFiles(files: FileNode[]) {
  const g: Record<FileNode["kind"], FileNode[]> = { frontend: [], backend: [], config: [], other: [] };
  for (const f of files) g[f.kind].push(f);
  return g;
}

export function buildStructureReport(a: AnalyzeResult): string {
  const g = groupFiles(a.files);
  const lines = [
    "# Project Structure Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Summary",
    `- Total files scanned: **${a.stats.totalFiles}**`,
    `- Used (auto-wired): **${a.stats.usedFiles}**`,
    `- Skipped (vendor/build/cache): **${a.stats.skipped.length}**`,
    `- Frontend detected: ${a.frontend.detected ? "✔ " + (a.frontend.framework ?? "unknown") : "✘"}`,
    `- Backend detected: ${a.backend.detected ? "✔ Laravel " + (a.backend.laravelVersion ?? "?") : "✘"}`,
    "",
    "## Frontend Files",
    ...g.frontend.slice(0, 200).map((f) => `- ${f.used ? "✅" : "▫️"} \`${f.path}\`${f.reason ? " — " + f.reason : ""}`),
    "",
    "## Backend Files",
    ...g.backend.slice(0, 200).map((f) => `- ${f.used ? "✅" : "▫️"} \`${f.path}\`${f.reason ? " — " + f.reason : ""}`),
    "",
    "## Config Files",
    ...g.config.map((f) => `- ${f.used ? "✅" : "▫️"} \`${f.path}\`${f.reason ? " — " + f.reason : ""}`),
    "",
    "## Detected Backend",
    `- Tables: ${a.backend.tables.length}`,
    `- Models: ${a.backend.models.length}`,
    `- Routes: ${a.backend.routes.length}`,
    `- Controllers: ${a.backend.controllers.length}`,
    `- Storage disks: ${a.backend.storageDisks.join(", ") || "none"}`,
    "",
    "## Detected Frontend",
    `- API call sites: ${a.frontend.apiCallSites.length}`,
    `- Base URLs: ${a.frontend.baseUrls.join(", ") || "none"}`,
    `- Env keys: ${a.frontend.envKeys.length}`,
    "",
  ];
  return lines.join("\n");
}
