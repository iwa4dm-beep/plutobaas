// One-click Ops for the VPS backend — migration apply + service restart + health.
//
// Proxies through the sandbox worker's authenticated /admin/ops endpoint,
// which sudo-runs /usr/local/sbin/pluto-ops (installed by
// deploy/install-pluto-ops.sh). All actions are strictly allow-listed on
// both sides of the wire; no arbitrary shell.
//
// Server-side only: reads PLUTO_SANDBOX_URL + PLUTO_SANDBOX_SECRET from env.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { getVpsBaseUrl } from "./vps-client";

export type OpsAction =
  | "migrations-plan"
  | "migrations-dry-run"
  | "migrations-apply"
  | "service-restart"
  | "service-health";

export type OpsService = "api" | "realtime" | "worker" | "nginx-reload";

export type OpsResult = {
  ok: boolean;
  action: OpsAction;
  service?: OpsService;
  exitCode: number;
  durationMs: number;
  tail: string;
  hint: string | null;
  startedAt: string;
  finishedAt: string;
  // Parsed structured output when the wrapper emits JSON on stdout.
  parsed?: string | null;
};

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function opsEndpoint(): { url: string; secret: string } | { error: string } {
  const base = getVpsBaseUrl();
  const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
  const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
  if (!secret) {
    return {
      error:
        "PLUTO_SANDBOX_SECRET is not configured. Run `sudo bash pluto-backend/deploy/print-sandbox-secret.sh` on the VPS and paste the value into Lovable Cloud → Secrets.",
    };
  }
  return { url: `${sandboxUrl}/admin/ops`, secret };
}

async function callOps(body: Record<string, unknown>, action: OpsAction, service?: OpsService): Promise<OpsResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const cfg = opsEndpoint();
  if ("error" in cfg) {
    return {
      ok: false, action, service, exitCode: -1, durationMs: 0,
      tail: "", hint: cfg.error, startedAt, finishedAt: new Date().toISOString(),
    };
  }
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-secret": cfg.secret,
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    const durationMs = Date.now() - t0;
    const finishedAt = new Date().toISOString();
    if (!r.ok) {
      let hint: string | null = null;
      if (r.status === 401) hint = "Sandbox secret mismatch. Sync PLUTO_SANDBOX_SECRET with the VPS.";
      else if (r.status === 404) hint = "The worker does not expose /admin/ops yet. Run `sudo bash pluto-backend/deploy/install-pluto-ops.sh` on the VPS.";
      else if (r.status === 403) hint = "sudoers rule for /usr/local/sbin/pluto-ops is missing. Rerun install-pluto-ops.sh.";
      else if (r.status === 502 || r.status === 503) hint = "Sandbox worker unreachable through nginx.";
      return { ok: false, action, service, exitCode: r.status, durationMs, tail: text.slice(-4096), hint, startedAt, finishedAt };
    }
    let parsed: {
      ok?: boolean; exitCode?: number; tail?: string; hint?: string | null; parsed?: unknown;
    } = {};
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    const parsedJson = parsed.parsed !== undefined
      ? (() => { try { return JSON.stringify(parsed.parsed); } catch { return null; } })()
      : null;
    return {
      ok: parsed.ok !== false && (parsed.exitCode == null || parsed.exitCode === 0),
      action, service,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
      durationMs,
      tail: (parsed.tail ?? text).slice(-4096),
      hint: parsed.hint ?? null,
      startedAt, finishedAt,
      parsed: parsedJson,
    };
  } catch (e) {
    return {
      ok: false, action, service, exitCode: -1,
      durationMs: Date.now() - t0,
      tail: e instanceof Error ? e.message : String(e),
      hint: "Network error reaching the sandbox worker.",
      startedAt, finishedAt: new Date().toISOString(),
    };
  }
}

/* ---------------- Migrations ---------------- */

export const planMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<OpsResult> => callOps({ action: "migrations-plan" }, "migrations-plan"));

export const dryRunMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<OpsResult> => callOps({ action: "migrations-dry-run" }, "migrations-dry-run"));

const ApplyInput = z.object({
  // typed confirmation — user must literally type "APPLY".
  confirm: z.literal("APPLY"),
});

export const applyMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => ApplyInput.parse(d))
  .handler(async (): Promise<OpsResult> => callOps({ action: "migrations-apply" }, "migrations-apply"));

/* ---------------- Services ---------------- */

const ServiceEnum = z.enum(["api", "realtime", "worker", "nginx-reload"]);

const RestartInput = z.object({
  service: ServiceEnum,
  // typed confirmation must equal the service name.
  confirm: z.string().min(1),
}).refine((d) => d.confirm === d.service, {
  message: "confirm must equal the service name",
  path: ["confirm"],
});

export const restartService = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => RestartInput.parse(d))
  .handler(async ({ data }): Promise<OpsResult> =>
    callOps({ action: "service-restart", service: data.service }, "service-restart", data.service),
  );

export const serviceHealth = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .handler(async (): Promise<OpsResult> => callOps({ action: "service-health" }, "service-health"));
