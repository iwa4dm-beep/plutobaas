/**
 * Config + session storage for the Pluto CLI.
 *
 * Project config → ./pluto.config.json (committed).
 * Session tokens → ~/.pluto/config.json, mode 0600, keyed by instance URL.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const ProjectConfig = z.object({
  url: z.string().url(),
  workspace: z.string().min(1),
  anonKey: z.string(),
  migrationsDir: z.string().default("./backend/apps/server/src/db/migrations"),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const Session = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresAt: z.number(),
  userEmail: z.string().email().optional(),
});
export type Session = z.infer<typeof Session>;

const CredStore = z.object({
  version: z.literal(1),
  sessions: z.record(z.string(), Session),
});
type CredStore = z.infer<typeof CredStore>;

const PROJECT_FILE = "pluto.config.json";
const CRED_FILE = resolve(homedir(), ".pluto", "config.json");

export async function loadProjectConfig(): Promise<ProjectConfig> {
  const raw = await readFile(resolve(process.cwd(), PROJECT_FILE), "utf8").catch(() => {
    throw new Error("No pluto.config.json in the current directory. Run `pluto init` first.");
  });
  return ProjectConfig.parse(JSON.parse(raw));
}

export async function saveProjectConfig(cfg: ProjectConfig): Promise<string> {
  const path = resolve(process.cwd(), PROJECT_FILE);
  await writeFile(path, JSON.stringify(ProjectConfig.parse(cfg), null, 2) + "\n", "utf8");
  return path;
}

async function readCreds(): Promise<CredStore> {
  const raw = await readFile(CRED_FILE, "utf8").catch(() => null);
  if (!raw) return { version: 1, sessions: {} };
  try { return CredStore.parse(JSON.parse(raw)); }
  catch { return { version: 1, sessions: {} }; }
}

async function writeCreds(store: CredStore): Promise<void> {
  await mkdir(dirname(CRED_FILE), { recursive: true });
  await writeFile(CRED_FILE, JSON.stringify(store, null, 2), "utf8");
  // Restrict to owner — mirrors ~/.aws/credentials, ~/.kube/config, etc.
  await chmod(CRED_FILE, 0o600).catch(() => { /* Windows: ignore */ });
}

export async function loadSession(url: string): Promise<Session | null> {
  const store = await readCreds();
  const s = store.sessions[url];
  if (!s) return null;
  if (s.expiresAt < Math.floor(Date.now() / 1000)) return null;
  return s;
}

export async function saveSession(url: string, session: Session): Promise<void> {
  const store = await readCreds();
  store.sessions[url] = Session.parse(session);
  await writeCreds(store);
}

export async function clearSession(url: string): Promise<void> {
  const store = await readCreds();
  delete store.sessions[url];
  await writeCreds(store);
}
