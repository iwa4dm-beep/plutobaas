#!/usr/bin/env node
// One-shot local release CLI for @timescard/pluto-js.
//   node scripts/sdk-publish.mjs patch          # bump + build + dry-run + publish
//   node scripts/sdk-publish.mjs minor --dry    # stop after dry-run
//   node scripts/sdk-publish.mjs 0.2.0          # explicit version
//
// Steps:
//   1. npm version <bump>          (in sdk-js)
//   2. npm run build               (tsup)
//   3. npm publish --dry-run       (verifies packaging)
//   4. npm publish --access public (real publish; skipped with --dry)
//   5. refresh tarballs + manifest via scripts/build-sdk-tarball.sh
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = resolve(ROOT, "pluto-backend/packages/sdk-js");

const argv = process.argv.slice(2);
const dryOnly = argv.includes("--dry");
const bumpArg = argv.find((a) => !a.startsWith("--")) ?? "patch";

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: SDK, ...opts });
}

if (!existsSync(resolve(SDK, "package.json"))) {
  console.error(`sdk-js package.json not found at ${SDK}`);
  process.exit(1);
}

console.log(`▶ Releasing @timescard/pluto-js (bump=${bumpArg}, dryOnly=${dryOnly})`);

// 1. bump — accept semver keyword or explicit version
const isExplicit = /^\d+\.\d+\.\d+/.test(bumpArg);
run(`npm version ${isExplicit ? bumpArg : bumpArg} --no-git-tag-version`);
const version = JSON.parse(readFileSync(resolve(SDK, "package.json"), "utf8")).version;
console.log(`  new version: ${version}`);

// 2. build
run(`npm install --no-audit --no-fund`);
run(`npm run build`);

// 3. dry-run
run(`npm publish --dry-run --access public`);

if (dryOnly) {
  console.log("\n✔ dry-run complete (--dry set) — nothing published.");
  process.exit(0);
}

// 4. real publish
try {
  run(`npm publish --access public`);
} catch (err) {
  console.error("✘ npm publish failed. Common fixes:");
  console.error("  • run `npm login` first");
  console.error("  • confirm org membership: `npm org ls timescard`");
  console.error("  • bump the version if it already exists on the registry");
  process.exit(1);
}

// 5. refresh downloadable tarballs
run(`bash ${resolve(ROOT, "scripts/build-sdk-tarball.sh")}`, { cwd: ROOT });

console.log(`\n✔ Published @timescard/pluto-js@${version}`);
console.log(`  npm:  https://www.npmjs.com/package/@timescard/pluto-js/v/${version}`);
console.log(`  next: git commit + tag v${version} && git push --tags`);
