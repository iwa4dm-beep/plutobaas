// Zero-downtime API key rotation planner.
//
// Rotation is modelled as an explicit, resumable state machine so a
// production key can be replaced without a single rejected request:
//
//   mint (new key live, old key still valid)
//     -> queue  (writers drain / clients pick up the new key)
//     -> roll   (rolling update: deploy targets swap one batch at a time)
//     -> verify (both keys observed healthy, new key serving traffic)
//     -> revoke (old key disabled)
//
// The grace window is what makes it downtime-free: the backend accepts BOTH
// keys until the last rolling batch reports healthy.

export type RotationKind = "anon" | "service_role";

export type RotationStage =
  | "plan" | "mint" | "queue" | "roll" | "verify" | "revoke" | "done" | "failed";

export type RollingTarget = {
  id: string;
  label: string;
  /** Batch index — targets in the same batch update together. */
  batch: number;
  status: "pending" | "updating" | "healthy" | "failed";
  note?: string;
};

export type RotationStep = {
  stage: RotationStage;
  title: string;
  detail: string;
  status: "pending" | "running" | "ok" | "failed" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

export type RotationPlan = {
  workspaceId: string;
  keyName: string;
  kind: RotationKind;
  /** Minutes both keys stay valid. */
  graceMinutes: number;
  batchSize: number;
  autoRevoke: boolean;
  targets: RollingTarget[];
  steps: RotationStep[];
  newKeyId?: string;
  newKeyPlaintext?: string;
  oldKeyIds: string[];
};

export type RotationInput = {
  workspaceId: string;
  keyName: string;
  kind: RotationKind;
  graceMinutes: number;
  batchSize: number;
  autoRevoke: boolean;
  targetLabels: string[];
  existingKeyIds: string[];
};

export function buildRotationPlan(input: RotationInput): RotationPlan {
  const size = Math.max(1, input.batchSize);
  const targets: RollingTarget[] = input.targetLabels
    .map((l) => l.trim())
    .filter(Boolean)
    .map((label, i) => ({
      id: `t${i + 1}`,
      label,
      batch: Math.floor(i / size),
      status: "pending" as const,
    }));

  const batches = targets.length ? Math.max(...targets.map((t) => t.batch)) + 1 : 0;

  const steps: RotationStep[] = [
    {
      stage: "mint",
      title: "Mint replacement key",
      detail: `Create a second ${input.kind} key named "${input.keyName}". Both keys are valid from this moment — no request is rejected.`,
      status: "pending",
    },
    {
      stage: "queue",
      title: `Queue grace window (${input.graceMinutes} min)`,
      detail: "In-flight requests using the old key drain while clients pick up the new value. Nothing is revoked yet.",
      status: "pending",
    },
    {
      stage: "roll",
      title: `Rolling update (${batches || 1} batch${batches === 1 ? "" : "es"})`,
      detail: "Each batch swaps its env value and must report healthy before the next batch starts. A failed batch halts the rollout with the old key still live.",
      status: "pending",
    },
    {
      stage: "verify",
      title: "Verify new key",
      detail: "Probe the API with the new key and confirm every target is healthy before anything is disabled.",
      status: "pending",
    },
    {
      stage: "revoke",
      title: input.autoRevoke ? "Revoke old key" : "Revoke old key (manual)",
      detail: input.autoRevoke
        ? "Old key is disabled only after verification passes."
        : "Auto-revoke is off — revoke manually once you are satisfied.",
      status: "pending",
    },
  ];

  return {
    workspaceId: input.workspaceId,
    keyName: input.keyName,
    kind: input.kind,
    graceMinutes: input.graceMinutes,
    batchSize: size,
    autoRevoke: input.autoRevoke,
    targets,
    steps,
    oldKeyIds: input.existingKeyIds,
  };
}

export function batchesOf(targets: RollingTarget[]): RollingTarget[][] {
  const max = targets.length ? Math.max(...targets.map((t) => t.batch)) : -1;
  const out: RollingTarget[][] = [];
  for (let b = 0; b <= max; b++) out.push(targets.filter((t) => t.batch === b));
  return out;
}

export function rotationProgress(plan: RotationPlan): number {
  const total = plan.steps.length;
  const done = plan.steps.filter((s) => s.status === "ok" || s.status === "skipped").length;
  return total ? Math.round((done / total) * 100) : 0;
}

/** Human-readable rollout summary, safe to paste into a change ticket. */
export function rotationSummary(plan: RotationPlan): string {
  return [
    `# Key rotation — ${plan.keyName} (${plan.kind})`,
    ``,
    `Workspace: ${plan.workspaceId}`,
    `Grace window: ${plan.graceMinutes} minutes (both keys valid)`,
    `Rolling batches: ${batchesOf(plan.targets).length || 1} × ${plan.batchSize}`,
    `Auto-revoke: ${plan.autoRevoke ? "yes, after verification" : "no"}`,
    ``,
    `## Steps`,
    ...plan.steps.map((s) => `- [${s.status}] ${s.title} — ${s.detail}`),
    ``,
    `## Targets`,
    ...(plan.targets.length
      ? plan.targets.map((t) => `- batch ${t.batch + 1}: ${t.label} — ${t.status}`)
      : ["- (none registered)"]),
  ].join("\n");
}

/** Env snippet handed to each rolling target during the grace window. */
export function dualKeyEnvSnippet(plan: RotationPlan): string {
  const varName = plan.kind === "anon" ? "PLUTO_ANON_KEY" : "PLUTO_SERVICE_ROLE_KEY";
  return `# During the grace window keep BOTH values deployed.
# Remove *_PREVIOUS once every batch is healthy.
${varName}=${plan.newKeyPlaintext ?? "<new key>"}
${varName}_PREVIOUS=<old key>
`;
}
