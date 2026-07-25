// Docker connectivity checker — proxies through the sandbox worker's
// authenticated /admin/docker-check endpoint, which runs a fixed set of
// docker inspection commands (compose ps, network inspect, getent hosts
// from inside the api container, and a redacted env dump of DATABASE_URL).
//
// The endpoint is strictly read-only: no arbitrary shell.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { getVpsBaseUrl } from "./vps-client";

export type DockerCheckReport = {
  ok: boolean;
  scope: "vps" | "local";
  hostname: string;
  compose: {
    project: string | null;
    services: Array<{ name: string; state: string; health: string | null; ports: string }>;
  };
  networks: Array<{ name: string; driver: string; containers: string[] }>;
  dns: Array<{ from: string; target: string; resolved: string | null; ok: boolean }>;
  ports: Array<{ container: string; port: number; reachable: boolean; via: string }>;
  env: {
    /** Redacted (password → ***) representation of DATABASE_URL seen by each container. */
    databaseUrl: Array<{ container: string; url: string | null; source: "container" | "compose" | "host" }>;
    plutoUrl: string | null;
    supabaseUrl: string | null;
  };
  tail: string;
  hint: string | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
};

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function endpointFor(scope: "vps" | "local"): { url: string; secret: string } | { error: string } {
  const base = getVpsBaseUrl();
  const url = envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`;
  const secret = envFirst(
    "PLUTO_SANDBOX_SECRET",
    "PLUTO_SANDBOX_SECRET_PROD",
    "PLUTO_SANDBOX_WORKER_SECRET",
    "SANDBOX_SHARED_SECRET",
  );
  if (!secret) {
    return { error: "PLUTO_SANDBOX_SECRET is not configured in Lovable Cloud → Secrets." };
  }
  return { url: `${url.replace(/\/+$/, "")}/admin/docker-check?scope=${scope}`, secret };
}

const Input = z.object({ scope: z.enum(["vps", "local"]).default("vps") });

export const runDockerCheck = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => Input.parse(d ?? {}))
  .handler(async ({ data }): Promise<DockerCheckReport> => {
    const started = new Date().toISOString();
    const t0 = Date.now();
    const ep = endpointFor(data.scope);
    if ("error" in ep) {
      return {
        ok: false, scope: data.scope, hostname: "unknown",
        compose: { project: null, services: [] }, networks: [], dns: [], ports: [],
        env: { databaseUrl: [], plutoUrl: null, supabaseUrl: null },
        tail: "", hint: ep.error, durationMs: 0,
        startedAt: started, finishedAt: new Date().toISOString(),
      };
    }
    try {
      const r = await fetch(ep.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-sandbox-secret": ep.secret, accept: "application/json" },
        body: JSON.stringify({ scope: data.scope }),
      });
      const text = await r.text();
      if (!r.ok) {
        let hint: string | null = null;
        if (r.status === 401) hint = "Sandbox secret mismatch. Sync PLUTO_SANDBOX_SECRET with the VPS.";
        else if (r.status === 404) hint = "Worker does not expose /admin/docker-check yet. Run `sudo bash pluto-backend/deploy/bootstrap-sandbox-worker.sh` on the VPS to pick up the latest worker code.";
        return {
          ok: false, scope: data.scope, hostname: "unknown",
          compose: { project: null, services: [] }, networks: [], dns: [], ports: [],
          env: { databaseUrl: [], plutoUrl: null, supabaseUrl: null },
          tail: text.slice(-4096), hint, durationMs: Date.now() - t0,
          startedAt: started, finishedAt: new Date().toISOString(),
        };
      }
      const parsed = JSON.parse(text) as DockerCheckReport;
      return { ...parsed, durationMs: Date.now() - t0, startedAt: started, finishedAt: new Date().toISOString() };
    } catch (e) {
      return {
        ok: false, scope: data.scope, hostname: "unknown",
        compose: { project: null, services: [] }, networks: [], dns: [], ports: [],
        env: { databaseUrl: [], plutoUrl: null, supabaseUrl: null },
        tail: e instanceof Error ? e.message : String(e),
        hint: "Network error reaching the sandbox worker.",
        durationMs: Date.now() - t0, startedAt: started, finishedAt: new Date().toISOString(),
      };
    }
  });
