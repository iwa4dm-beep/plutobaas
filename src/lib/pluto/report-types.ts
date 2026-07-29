// Client-safe shape of the downloadable import report bundle.
import type { ImportEventView, ImportJobView, SqlVersionView } from "./import-job.functions";
import type { SqlDiff } from "./sql-diff";
import type { SmokeReport } from "./smoke-types";
import type { VerificationDiff } from "./verification-diff";

export type VerificationRunView = {
  run_no: number;
  ok: boolean;
  trigger: string;
  actor_email: string | null;
  created_at: string;
  report: SmokeReport;
  diff: VerificationDiff | null;
};

export type ImportReportBundle = {
  generatedAt: string;
  generatedBy: string | null;
  /** Present when the bundle was fetched through a signed share link. */
  shared?: { expiresAt: string; createdBy: string | null } | null;
  job: ImportJobView;
  diff: SqlDiff | null;
  verification: SmokeReport | null;
  verificationRuns: VerificationRunView[];
  versions: (SqlVersionView & { sql?: string })[];
  events: ImportEventView[];
  failures: { step: string; created_at: string; message: string | null; detail: string | null }[];
  migrationSql: string | null;
};
