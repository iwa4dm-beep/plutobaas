// One-click Ops for the VPS backend — migrations, staged rollouts, rollback,
// backups, and audit — with per-environment (dev/staging/prod) targeting.
//
// Proxies through the sandbox worker's authenticated /admin/ops endpoint,
// which sudo-runs /usr/local/sbin/pluto-ops (installed by
// deploy/install-pluto-ops.sh). All actions are strictly allow-listed on
// both sides of the wire; no arbitrary shell.
//
// Environment configuration — the URL and secret can be set per env via
// Lovable Cloud secrets. Falls back to the existing PLUTO_SANDBOX_URL /
// PLUTO_SANDBOX_SECRET pair for prod.
//
//   PLUTO_SANDBOX_URL_DEV     PLUTO_SANDBOX_SECRET_DEV
//   PLUTO_SANDBOX_URL_STAGING PLUTO_SANDBOX_SECRET_STAGING
//   PLUTO_SANDBOX_URL_PROD    PLUTO_SANDBOX_SECRET_PROD
//
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { getVpsBaseUrl } from "./vps-client";

export type OpsEnv = "dev" | "staging" | "prod";

export type OpsAction =
  | "migrations-plan"
  | "migrations-dry-run"
  | "migrations-apply"
  | "migrations-rollback-plan"
  | "migrations-rollback-apply"
  | "service-restart"
  | "service-rollout"
  | "service-health"
  | "backup-create"
  | "backup-list"
  | "backup-restore";

export type OpsService = "api" | "realtime" | "worker" | "nginx-reload";
export type RolloutPlan = "auto" | "workers-only" | "canary-api" | "full";

export type OpsResult = {
  ok: boolean;
  action: OpsAction;
  env: OpsEnv;
  service?: OpsService | null;
  exitCode: number;
  durationMs: number;
  tail: string;
  hint: string | null;
  startedAt: string;
  finishedAt: string;
  backupId?: string | null;
};

export type OpsAuditEntry = {
  id: string;
  env: OpsEnv;
  action: OpsAction;
  service?: OpsService | null;
  params?: {
    plan?: string | null;
    target?: string | null;
    allowMissingDown?: boolean;
    soakSeconds?: number | null;
    id?: string | null;
  } | null;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  hint: string | null;
  tail: string;
  backupId?: string | null;
  actorEmail?: string | null;
  actorUserId?: string | null;
  startedAt: string;
  finishedAt: string;
};

export type OpsBackupEntry = {
  id: string;
  env: OpsEnv;
  path: string;
  size: number;
  sha256: string;
  createdAt: string;
  status: string;
};

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

function opsEndpointFor(env: OpsEnv): { url: string; secret: string } | { error: string } {
  const suffix = env.toUpperCase();
  const base = getVpsBaseUrl();
  const url = envFirst(`PLUTO_SANDBOX_URL_${suffix}`, "PLUTO_SANDBOX_URL") || `${base}/sandbox`;
  const secret =
    env === "prod"
      ? envFirst("PLUTO_SANDBOX_SECRET_PROD", "PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET")
      : envFirst(`PLUTO_SANDBOX_SECRET_${suffix}`);
  if (!secret) {
    return {
      error: `Sandbox secret for env=${env} is not configured. Add PLUTO_SANDBOX_SECRET_${suffix} in Lovable Cloud → Secrets.`,
    };
  }
  return { url: `${url.replace(/\/+$/, "")}/admin/ops`, secret };
}

function auditListEndpointFor(env: OpsEnv, path: "audit" | "backups"): { url: string; secret: string } | { error: string } {
  const ep = opsEndpointFor(env);
  if ("error" in ep) return ep;
  return { url: ep.url.replace(/\/admin\/ops$/, `/admin/ops/${path}`), secret: ep.secret };
}

async function callOps(env: OpsEnv, body: Record<string, unknown>, action: OpsAction, service?: OpsService, actor?: { email?: string | null; userId?: string | null }): Promise<OpsResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const cfg = opsEndpointFor(env);
  if ("error" in cfg) {
    return { ok: false, action, env, service: service ?? null, exitCode: -1, durationMs: 0, tail: "", hint: cfg.error, startedAt, finishedAt: new Date().toISOString(), backupId: null };
  }
  try {
    const r = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sandbox-secret": cfg.secret,
        "x-actor-email": actor?.email ?? "",
        "x-actor-user-id": actor?.userId ?? "",
        accept: "application/json",
      },
      body: JSON.stringify({ ...body, env }),
    });
    const text = await r.text();
    const durationMs = Date.now() - t0;
    const finishedAt = new Date().toISOString();
    if (!r.ok) {
      let hint: string | null = null;
      if (r.status === 401) hint = "Sandbox secret mismatch. Sync PLUTO_SANDBOX_SECRET* with the VPS.";
      else if (r.status === 404) hint = "The worker does not expose /admin/ops yet. Run `sudo bash pluto-backend/deploy/install-pluto-ops.sh` on the VPS.";
      else if (r.status === 502 || r.status === 503) hint = "Sandbox worker unreachable through nginx.";
      return { ok: false, action, env, service: service ?? null, exitCode: r.status, durationMs, tail: text.slice(-4096), hint, startedAt, finishedAt, backupId: null };
    }
    let parsed: { ok?: boolean; exitCode?: number; tail?: string; hint?: string | null; backupId?: string | null } = {};
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }
    return {
      ok: parsed.ok !== false && (parsed.exitCode == null || parsed.exitCode === 0),
      action, env, service: service ?? null,
      exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : 0,
      durationMs,
      tail: (parsed.tail ?? text).slice(-4096),
      hint: parsed.hint ?? null,
      backupId: parsed.backupId ?? null,
      startedAt, finishedAt,
    };
  } catch (e) {
    return {
      ok: false, action, env, service: service ?? null, exitCode: -1,
      durationMs: Date.now() - t0,
      tail: e instanceof Error ? e.message : String(e),
      hint: "Network error reaching the sandbox worker.",
      startedAt, finishedAt: new Date().toISOString(), backupId: null,
    };
  }
}

const EnvEnum = z.enum(["dev", "staging", "prod"]);
const ServiceEnum = z.enum(["api", "realtime", "worker", "nginx-reload"]);
const PlanEnum = z.enum(["auto", "workers-only", "canary-api", "full"]);

/* ---------------- Environments ---------------- */

export const listOpsEnvironments = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .handler(async () => {
    const envs: OpsEnv[] = ["dev", "staging", "prod"];
    return envs.map((env) => {
      const ep = opsEndpointFor(env);
      return { env, configured: !("error" in ep) };
    });
  });

/* ---------------- Migrations ---------------- */

const PlanMigrationsInput = z.object({ env: EnvEnum.default("prod") });

export const planMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => PlanMigrationsInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "migrations-plan" }, "migrations-plan", undefined, actorFrom(context)),
  );

export const dryRunMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => PlanMigrationsInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "migrations-dry-run" }, "migrations-dry-run", undefined, actorFrom(context)),
  );

const ApplyInput = z.object({
  env: EnvEnum.default("prod"),
  confirm: z.string(), // "APPLY" (dev/staging) or "APPLY-PROD" (prod)
  skipBackup: z.boolean().optional().default(false),
});

export const applyMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => {
    const parsed = ApplyInput.parse(d);
    const expected = parsed.env === "prod" ? "APPLY-PROD" : "APPLY";
    if (parsed.confirm !== expected) throw new Error(`confirm must equal "${expected}"`);
    return parsed;
  })
  .handler(async ({ data, context }): Promise<{ backup: OpsResult | null; apply: OpsResult }> => {
    const actor = actorFrom(context);
    let backup: OpsResult | null = null;
    if (!data.skipBackup) {
      backup = await callOps(data.env, { action: "backup-create" }, "backup-create", undefined, actor);
      if (!backup.ok) {
        return {
          backup,
          apply: { ok: false, action: "migrations-apply", env: data.env, service: null, exitCode: -1, durationMs: 0, tail: "aborted: pre-apply backup failed", hint: "Re-submit with skipBackup=true to proceed anyway.", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), backupId: null },
        };
      }
    }
    const apply = await callOps(data.env, { action: "migrations-apply" }, "migrations-apply", undefined, actor);
    return { backup, apply };
  });

const RollbackInput = z.object({
  env: EnvEnum.default("prod"),
  target: z.string().regex(/^[0-9]{1,6}$/),
  allowMissingDown: z.boolean().optional().default(false),
});

export const planRollbackMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => RollbackInput.parse(d))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "migrations-rollback-plan", target: data.target, allowMissingDown: data.allowMissingDown }, "migrations-rollback-plan", undefined, actorFrom(context)),
  );

const RollbackApplyInput = RollbackInput.extend({
  confirm: z.string(),
}).refine((d) => d.confirm === (d.env === "prod" ? "ROLLBACK-PROD" : "ROLLBACK"), {
  message: 'confirm must equal "ROLLBACK" (or "ROLLBACK-PROD" for prod)',
  path: ["confirm"],
});

export const applyRollbackMigrations = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => RollbackApplyInput.parse(d))
  .handler(async ({ data, context }): Promise<{ backup: OpsResult; rollback: OpsResult }> => {
    const actor = actorFrom(context);
    const backup = await callOps(data.env, { action: "backup-create" }, "backup-create", undefined, actor);
    if (!backup.ok) {
      return {
        backup,
        rollback: { ok: false, action: "migrations-rollback-apply", env: data.env, service: null, exitCode: -1, durationMs: 0, tail: "aborted: pre-rollback backup failed", hint: "Backup is mandatory before rollback.", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), backupId: null },
      };
    }
    const rollback = await callOps(
      data.env,
      { action: "migrations-rollback-apply", target: data.target, allowMissingDown: data.allowMissingDown },
      "migrations-rollback-apply", undefined, actor,
    );
    return { backup, rollback };
  });

/* ---------------- Services ---------------- */

const RestartInput = z.object({
  env: EnvEnum.default("prod"),
  service: ServiceEnum,
  confirm: z.string().min(1),
}).refine((d) => d.confirm === d.service, {
  message: "confirm must equal the service name",
  path: ["confirm"],
});

export const restartService = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => RestartInput.parse(d))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "service-restart", service: data.service }, "service-restart", data.service, actorFrom(context)),
  );

const RolloutInput = z.object({
  env: EnvEnum.default("prod"),
  plan: PlanEnum.default("auto"),
  soakSeconds: z.number().int().min(0).max(300).optional().default(30),
  confirm: z.string(),
}).refine((d) => d.confirm === (d.env === "prod" ? "ROLLOUT-PROD" : "ROLLOUT"), {
  message: 'confirm must equal "ROLLOUT" (or "ROLLOUT-PROD" for prod)',
  path: ["confirm"],
});

export const rolloutServices = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => RolloutInput.parse(d))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "service-rollout", plan: data.plan, soakSeconds: data.soakSeconds }, "service-rollout", undefined, actorFrom(context)),
  );

const HealthInput = z.object({ env: EnvEnum.default("prod") });

export const serviceHealth = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => HealthInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "service-health" }, "service-health", undefined, actorFrom(context)),
  );

/* ---------------- Backups ---------------- */

const BackupCreateInput = z.object({ env: EnvEnum.default("prod") });

export const createBackup = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => BackupCreateInput.parse(d ?? {}))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "backup-create" }, "backup-create", undefined, actorFrom(context)),
  );

const BackupRestoreInput = z.object({
  env: EnvEnum.default("prod"),
  id: z.string().regex(/^[A-Za-z0-9._-]{4,128}$/),
  confirm: z.string(),
}).refine((d) => d.confirm === (d.env === "prod" ? "RESTORE-PROD" : "RESTORE"), {
  message: 'confirm must equal "RESTORE" (or "RESTORE-PROD" for prod)',
  path: ["confirm"],
});

export const restoreBackup = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => BackupRestoreInput.parse(d))
  .handler(async ({ data, context }): Promise<OpsResult> =>
    callOps(data.env, { action: "backup-restore", id: data.id }, "backup-restore", undefined, actorFrom(context)),
  );

const ListInput = z.object({ env: EnvEnum.default("prod"), limit: z.number().int().min(1).max(500).optional().default(50) });

export const listBackups = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => ListInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<{ ok: boolean; entries: OpsBackupEntry[]; error?: string }> => {
    const cfg = auditListEndpointFor(data.env, "backups");
    if ("error" in cfg) return { ok: false, entries: [], error: cfg.error };
    try {
      const r = await fetch(`${cfg.url}?env=${data.env}&limit=${data.limit}`, {
        headers: { "x-sandbox-secret": cfg.secret, accept: "application/json" },
      });
      if (!r.ok) return { ok: false, entries: [], error: `HTTP ${r.status}` };
      const j = (await r.json()) as { ok?: boolean; entries?: OpsBackupEntry[] };
      return { ok: true, entries: j.entries ?? [] };
    } catch (e) {
      return { ok: false, entries: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

/* ---------------- Audit ---------------- */

const AuditListInput = z.object({
  env: EnvEnum.default("prod"),
  action: z.string().optional(),
  actor: z.string().optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
});

export const listOpsAudit = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => AuditListInput.parse(d ?? {}))
  .handler(async ({ data }): Promise<{ ok: boolean; entries: OpsAuditEntry[]; error?: string }> => {
    const cfg = auditListEndpointFor(data.env, "audit");
    if ("error" in cfg) return { ok: false, entries: [], error: cfg.error };
    try {
      const qs = new URLSearchParams({ env: data.env, limit: String(data.limit) });
      if (data.action) qs.set("action", data.action);
      if (data.actor) qs.set("actor", data.actor);
      const r = await fetch(`${cfg.url}?${qs.toString()}`, {
        headers: { "x-sandbox-secret": cfg.secret, accept: "application/json" },
      });
      if (!r.ok) return { ok: false, entries: [], error: `HTTP ${r.status}` };
      const j = (await r.json()) as { ok?: boolean; entries?: OpsAuditEntry[] };
      return { ok: true, entries: j.entries ?? [] };
    } catch (e) {
      return { ok: false, entries: [], error: e instanceof Error ? e.message : String(e) };
    }
  });

/* ---------------- helpers ---------------- */

function actorFrom(context: unknown): { email?: string | null; userId?: string | null } {
  const c = context as { plutoAdmin?: { userId?: string; email?: string } } | undefined;
  return { email: c?.plutoAdmin?.email ?? null, userId: c?.plutoAdmin?.userId ?? null };
}
