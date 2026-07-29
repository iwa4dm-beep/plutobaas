// Shared (client-safe) result shapes for post-apply integrity checks.
export type CheckStatus = "pass" | "warn" | "fail";

export type SmokeCheck = {
  /** Stable id, e.g. `exists:public.notes`. */
  id: string;
  /** Human label shown in the timeline / report. */
  label: string;
  /** `public.notes`, or `—` for database-wide checks. */
  target: string;
  status: CheckStatus;
  detail: string;
  rowCount: number | null;
};

export type SmokeReport = {
  ok: boolean;
  ranAt: string;
  durationMs: number;
  targets: string[];
  counts: { pass: number; warn: number; fail: number };
  checks: SmokeCheck[];
};
