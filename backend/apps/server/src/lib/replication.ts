// Phase 54 — Cross-region replication with retry, backoff, checksum verify,
// idempotency, and ordering guarantees (per-object monotone).

export type Job = {
  id: string;
  bucket: string;
  object_key: string;
  version_id: string;
  source_region: string;
  target_region: string;
  idempotency_key: string;
  status: "pending" | "running" | "succeeded" | "failed" | "skipped";
  attempts: number;
  last_error: string | null;
  checksum_verified: boolean;
  next_attempt_at: number;
  completed_at: number | null;
  created_at: number;
};

const jobs = new Map<string, Job>(); // by id
const byIdem = new Map<string, string>(); // idempotency_key -> job id
// Per-(target,bucket,object) monotone cursor — replicated version_ids are
// tracked so out-of-order arrivals never overwrite a newer version.
const cursor = new Map<string, string>(); // key -> last replicated version_id (created_at composite)
const ckey = (t: string, b: string, k: string) => `${t}/${b}/${k}`;
let seq = 0;

const BACKOFF = [50, 200, 1_000, 5_000, 30_000]; // ms; capped

export function submit(input: Omit<Job, "id" | "status" | "attempts" | "last_error" | "checksum_verified" | "next_attempt_at" | "completed_at" | "created_at">): Job {
  const existingId = byIdem.get(input.idempotency_key);
  if (existingId) return jobs.get(existingId)!;
  const job: Job = {
    id: `rj_${++seq}`,
    status: "pending",
    attempts: 0,
    last_error: null,
    checksum_verified: false,
    next_attempt_at: Date.now(),
    completed_at: null,
    created_at: Date.now(),
    ...input,
  };
  jobs.set(job.id, job);
  byIdem.set(job.idempotency_key, job.id);
  return job;
}

export type TransferResult = { ok: boolean; remote_checksum?: string; error?: string };

export async function runOnce(
  jobId: string,
  transfer: (j: Job) => Promise<TransferResult>,
  expected_checksum: string,
  version_created_at: number,
): Promise<Job> {
  const job = jobs.get(jobId);
  if (!job) throw new Error("job_not_found");
  if (job.status === "succeeded" || job.status === "skipped") return job;
  if (job.next_attempt_at > Date.now()) return job;

  // Ordering: skip if a newer version was already replicated to the target.
  const c = ckey(job.target_region, job.bucket, job.object_key);
  const prev = cursor.get(c);
  if (prev && prev >= `${version_created_at}::${job.version_id}`) {
    job.status = "skipped";
    job.completed_at = Date.now();
    return job;
  }

  job.status = "running";
  job.attempts++;
  try {
    const r = await transfer(job);
    if (!r.ok) throw new Error(r.error ?? "transfer_failed");
    if (r.remote_checksum && r.remote_checksum !== expected_checksum) {
      throw new Error(`checksum_mismatch:${r.remote_checksum}!=${expected_checksum}`);
    }
    job.checksum_verified = true;
    job.status = "succeeded";
    job.completed_at = Date.now();
    cursor.set(c, `${version_created_at}::${job.version_id}`);
  } catch (e) {
    job.last_error = (e as Error).message;
    const wait = BACKOFF[Math.min(job.attempts - 1, BACKOFF.length - 1)]!;
    job.next_attempt_at = Date.now() + wait;
    job.status = job.attempts >= 5 ? "failed" : "pending";
  }
  return job;
}

export function statusFor(bucket: string, object_key: string, version_id: string): Job[] {
  return [...jobs.values()].filter((j) => j.bucket === bucket && j.object_key === object_key && j.version_id === version_id);
}

export function listJobs(): Job[] { return [...jobs.values()]; }
export function clearJobs(): void { jobs.clear(); byIdem.clear(); cursor.clear(); seq = 0; }
