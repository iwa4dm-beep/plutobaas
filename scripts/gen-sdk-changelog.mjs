#!/usr/bin/env node
// Generate a CHANGELOG entry from git commits since the last SDK tag,
// then splice it into the SDK README under a "## Changelog" section.
//
// Usage:
//   node scripts/gen-sdk-changelog.mjs \
//     --version 0.1.1 \
//     --out    pluto-backend/packages/sdk-js/CHANGELOG.md \
//     --readme pluto-backend/packages/sdk-js/README.md
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith("--")) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const version = args.version;
const outPath = args.out;
const readmePath = args.readme;
if (!version || !outPath) {
  console.error("usage: gen-sdk-changelog.mjs --version X --out CHANGELOG.md [--readme README.md]");
  process.exit(2);
}

function sh(cmd) {
  try { return execSync(cmd, { encoding: "utf8" }).trim(); } catch { return ""; }
}

// Find the previous SDK tag (v* or sdk-v*), fall back to root commit.
const prevTag = sh(`git describe --tags --abbrev=0 --match "v*" --match "sdk-v*" HEAD^ 2>/dev/null`) ||
                sh(`git rev-list --max-parents=0 HEAD | head -1`);
const range = prevTag ? `${prevTag}..HEAD` : "HEAD";

const raw = sh(`git log ${range} --pretty=format:"%s|%h" -- pluto-backend/packages/sdk-js`);
const lines = raw ? raw.split("\n") : [];

const groups = { feat: [], fix: [], chore: [], docs: [], other: [] };
for (const line of lines) {
  const [subject, sha] = line.split("|");
  if (!subject) continue;
  const m = subject.match(/^(feat|fix|chore|docs|perf|refactor|test)(\(.+?\))?:\s*(.+)$/i);
  const bucket = m ? m[1].toLowerCase() : "other";
  const text = m ? m[3] : subject;
  (groups[bucket] || groups.other).push(`- ${text} (${sha})`);
}

const today = new Date().toISOString().slice(0, 10);
let entry = `## ${version} — ${today}\n\n`;
const order = [["feat", "Features"], ["fix", "Fixes"], ["perf", "Performance"], ["refactor", "Refactor"], ["docs", "Docs"], ["chore", "Chores"], ["other", "Other"]];
let any = false;
for (const [k, label] of order) {
  const items = groups[k];
  if (!items || !items.length) continue;
  entry += `### ${label}\n${items.join("\n")}\n\n`;
  any = true;
}
if (!any) entry += `_No user-facing changes recorded._\n\n`;

// Prepend to CHANGELOG.md
const header = `# Changelog\n\n`;
let existing = existsSync(outPath) ? readFileSync(outPath, "utf8") : header;
if (!existing.startsWith(header)) existing = header + existing;
const body = existing.slice(header.length);
if (!body.includes(`## ${version} —`)) {
  writeFileSync(outPath, header + entry + body);
  console.log(`✔ prepended ${version} to ${outPath}`);
} else {
  console.log(`= ${version} already in ${outPath}, skipping`);
}

// Splice latest entry into README under "## Changelog"
if (readmePath && existsSync(readmePath)) {
  const readme = readFileSync(readmePath, "utf8");
  const marker = "## Changelog";
  const latestBlock = `${marker}\n\n${entry}> Full history: [CHANGELOG.md](./CHANGELOG.md)\n`;
  let next;
  if (readme.includes(marker)) {
    next = readme.replace(new RegExp(`${marker}[\\s\\S]*?(?=\\n## |$)`), latestBlock.trim() + "\n\n");
  } else {
    next = readme.trimEnd() + `\n\n${latestBlock}`;
  }
  writeFileSync(readmePath, next);
  console.log(`✔ updated ${readmePath} with ${version} changelog`);
}
