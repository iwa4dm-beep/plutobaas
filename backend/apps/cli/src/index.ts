#!/usr/bin/env node
/**
 * Pluto CLI — Phase 14.0 skeleton.
 *
 * The full command surface (migrations / sql / workspaces / functions /
 * secrets) lands in Phase 14.4. This entrypoint intentionally ships only
 * the plumbing (config loader, session store, HTTP client, command router)
 * so the SDK-facing pieces can slot in without another refactor.
 */
import { Command } from "commander";
import kleur from "kleur";
import { loadProjectConfig, loadSession, saveProjectConfig } from "./config.js";
import { plutoFetch } from "./http.js";

const program = new Command();

program
  .name("pluto")
  .description("Pluto BaaS command-line client")
  .version("0.1.0-phase14.0", "-v, --version");

// ─── init ────────────────────────────────────────────────────────────────────
program
  .command("init")
  .description("Create a pluto.config.json in the current directory")
  .option("--url <url>", "Pluto backend URL", "http://localhost:8080")
  .option("--workspace <slug>", "Default workspace slug", "default")
  .action(async (opts: { url: string; workspace: string }) => {
    const path = await saveProjectConfig({
      url: opts.url,
      workspace: opts.workspace,
      anonKey: "",
      migrationsDir: "./backend/apps/server/src/db/migrations",
    });
    console.log(kleur.green(`✓ wrote ${path}`));
    console.log(kleur.dim("  Fill in `anonKey` from the dashboard, then run `pluto login`."));
  });

// ─── whoami ──────────────────────────────────────────────────────────────────
program
  .command("whoami")
  .description("Print the current session and target instance")
  .action(async () => {
    const cfg = await loadProjectConfig();
    const sess = await loadSession(cfg.url);
    if (!sess) {
      console.log(kleur.yellow("Not logged in.")); console.log(`  Instance: ${kleur.cyan(cfg.url)}`); console.log(`  Workspace: ${kleur.cyan(cfg.workspace)}`);
      console.log(kleur.dim("\nRun `pluto login` (available in 14.4)."));
      return;
    }
    // In 14.4 this hits /auth/v1/user with the stored bearer.
    const me = await plutoFetch(cfg.url, "/auth/v1/user", { token: sess.accessToken }).catch(() => null);
    console.log(`  Instance : ${kleur.cyan(cfg.url)}`);
    console.log(`  Workspace: ${kleur.cyan(cfg.workspace)}`);
    console.log(`  User     : ${me ? kleur.green(String((me as { email?: string }).email ?? "?")) : kleur.red("session expired")}`);
  });

// ─── placeholders (14.1-14.4) ────────────────────────────────────────────────
for (const [name, help] of [
  ["login",      "Device-flow login"],
  ["migrations", "Manage database migrations (new/status/apply/rollback/dry-run)"],
  ["sql",        "Run a SQL file or stdin against the workspace"],
  ["workspaces", "list | create | keys"],
  ["functions",  "list | deploy | remove | invoke"],
  ["secrets",    "set | list | delete"],
] as const) {
  program
    .command(name)
    .description(help + " (coming in Phase 14.4)")
    .action(() => {
      console.log(kleur.yellow(`\`pluto ${name}\` is stubbed in Phase 14.0.`));
      console.log(kleur.dim("Track progress in docs/PHASE-14.md."));
      process.exitCode = 2;
    });
}

program.parseAsync(process.argv).catch((err) => {
  console.error(kleur.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
