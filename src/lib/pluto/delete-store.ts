// Client-side orchestration for soft-delete + VPS purge jobs + audit log.
// Persists in localStorage; a single-flight scheduler drains jobs whose
// `runAfter` has elapsed. Purely additive to the existing Pluto admin API —
// the actual DB row removal happens when the purge fires, not at soft-delete.
//
// Everything is namespaced under `pluto.delete-store.v1` so upgrades can
// re-key later without stomping older shapes.

import { live } from "./live";

export type DeleteKind = "project" | "user";

export type JobStatus = "queued" | "running" | "ok" | "failed" | "cancelled";

export type PurgeJob = {
  id: string;
  kind: DeleteKind;
  targetId: string;
  label: string;
  slug?: string; // projects only
  autoPurgeSlug: boolean;
  status: JobStatus;
  attempts: number;
  lastError?: string;
  hint?: string;
  removed: string[];
  dbOk?: boolean;
  dbError?: string;
  createdAt: string;
  updatedAt: string;
  runAfter: string;
  createdBy: { id: string | null; email: string | null };
};

export type SoftDelete = {
  id: string; // same as targetId
  kind: DeleteKind;
  targetId: string;
  label: string;
  slug?: string;
  deletedAt: string;
  purgeAfter: string;
  deletedBy: { id: string | null; email: string | null };
  jobId: string;
};

export type AuditEntry = {
  id: string;
  at: string;
  actor: { id: string | null; email: string | null };
  action:
    | "soft_delete_project"
    | "soft_delete_user"
    | "restore_project"
    | "restore_user"
    | "purge_project"
    | "purge_user";
  targetId: string;
  targetLabel: string;
  dbOk?: boolean;
  dbError?: string;
  vpsJobId?: string;
  vpsOk?: boolean;
  vpsRemoved?: string[];
  vpsErrors?: string[];
};

type State = {
  jobs: PurgeJob[];
  softDeletes: SoftDelete[];
  audit: AuditEntry[];
  settings: { windowMs: number };
};

const KEY = "pluto.delete-store.v1";
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

function empty(): State {
  return { jobs: [], softDeletes: [], audit: [], settings: { windowMs: DEFAULT_WINDOW_MS } };
}

function read(): State {
  if (typeof window === "undefined") return empty();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      jobs: parsed.jobs ?? [],
      softDeletes: parsed.softDeletes ?? [],
      audit: parsed.audit ?? [],
      settings: { windowMs: parsed.settings?.windowMs ?? DEFAULT_WINDOW_MS },
    };
  } catch {
    return empty();
  }
}

function write(s: State) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota / private mode — ignore */
  }
}

type Listener = (s: State) => void;
const listeners = new Set<Listener>();

function emit() {
  const s = read();
  for (const fn of listeners) {
    try { fn(s); } catch { /* ignore */ }
  }
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(read());
  return () => { listeners.delete(fn); };
}

export function getState(): State {
  return read();
}

export function setWindowMs(ms: number) {
  const s = read();
  s.settings.windowMs = Math.max(0, ms | 0);
  write(s);
  emit();
}

function uid(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;
}

function audit(entry: Omit<AuditEntry, "id" | "at">) {
  const s = read();
  s.audit.unshift({ id: uid(), at: new Date().toISOString(), ...entry });
  // Keep last 500 entries client-side.
  if (s.audit.length > 500) s.audit.length = 500;
  write(s);
  emit();
}

function currentActor(): { id: string | null; email: string | null } {
  try {
    const u = live.auth.session()?.user ?? null;
    return { id: u?.id ?? null, email: (u?.email as string | undefined) ?? null };
  } catch {
    return { id: null, email: null };
  }
}

export function enqueueSoftDelete(input: {
  kind: DeleteKind;
  targetId: string;
  label: string;
  slug?: string;
  autoPurgeSlug?: boolean;
  /** Override the configured window; 0 = purge immediately. */
  windowMs?: number;
}): { jobId: string; softDeleteId: string } {
  const s = read();
  const windowMs = input.windowMs ?? s.settings.windowMs;
  const now = new Date();
  const runAfter = new Date(now.getTime() + windowMs).toISOString();
  const jobId = uid();
  const actor = currentActor();
  const job: PurgeJob = {
    id: jobId,
    kind: input.kind,
    targetId: input.targetId,
    label: input.label,
    slug: input.slug,
    autoPurgeSlug: input.kind === "project" ? input.autoPurgeSlug !== false : false,
    status: "queued",
    attempts: 0,
    removed: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    runAfter,
    createdBy: actor,
  };
  const sd: SoftDelete = {
    id: input.targetId,
    kind: input.kind,
    targetId: input.targetId,
    label: input.label,
    slug: input.slug,
    deletedAt: now.toISOString(),
    purgeAfter: runAfter,
    deletedBy: actor,
    jobId,
  };
  s.jobs.unshift(job);
  s.softDeletes.unshift(sd);
  write(s);
  emit();
  audit({
    actor,
    action: input.kind === "project" ? "soft_delete_project" : "soft_delete_user",
    targetId: input.targetId,
    targetLabel: input.label,
    vpsJobId: jobId,
  });
  // Kick the scheduler.
  scheduleTick();
  return { jobId, softDeleteId: sd.id };
}

export function cancelSoftDelete(targetId: string): boolean {
  const s = read();
  const sdIdx = s.softDeletes.findIndex((x) => x.targetId === targetId);
  if (sdIdx === -1) return false;
  const sd = s.softDeletes[sdIdx];
  s.softDeletes.splice(sdIdx, 1);
  const job = s.jobs.find((j) => j.id === sd.jobId);
  if (job && (job.status === "queued" || job.status === "failed")) {
    job.status = "cancelled";
    job.updatedAt = new Date().toISOString();
  }
  write(s);
  audit({
    actor: currentActor(),
    action: sd.kind === "project" ? "restore_project" : "restore_user",
    targetId: sd.targetId,
    targetLabel: sd.label,
  });
  emit();
  return true;
}

export function purgeNow(targetId: string) {
  const s = read();
  const sd = s.softDeletes.find((x) => x.targetId === targetId);
  if (!sd) return;
  const job = s.jobs.find((j) => j.id === sd.jobId);
  if (!job) return;
  job.runAfter = new Date().toISOString();
  if (job.status === "failed") job.status = "queued";
  sd.purgeAfter = job.runAfter;
  write(s);
  emit();
  scheduleTick();
}

export function retryJob(jobId: string) {
  const s = read();
  const job = s.jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (job.status !== "failed" && job.status !== "cancelled") return;
  job.status = "queued";
  job.runAfter = new Date().toISOString();
  job.updatedAt = job.runAfter;
  write(s);
  emit();
  scheduleTick();
}

export function softDeletedIds(kind: DeleteKind): Set<string> {
  const s = read();
  return new Set(s.softDeletes.filter((x) => x.kind === kind).map((x) => x.targetId));
}

export function timeRemainingMs(sd: SoftDelete): number {
  return new Date(sd.purgeAfter).getTime() - Date.now();
}

// ─── scheduler ─────────────────────────────────────────────────────────────

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

function scheduleTick(delay = 0) {
  if (typeof window === "undefined") return;
  if (tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void tick();
  }, delay);
}

async function tick() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const s = read();
      const now = Date.now();
      const next = s.jobs.find((j) => j.status === "queued" && new Date(j.runAfter).getTime() <= now);
      if (!next) {
        // If future-queued jobs exist, schedule a wake-up.
        const soonest = s.jobs
          .filter((j) => j.status === "queued")
          .map((j) => new Date(j.runAfter).getTime())
          .sort((a, b) => a - b)[0];
        if (soonest) scheduleTick(Math.max(1000, soonest - Date.now()));
        return;
      }
      await runJob(next.id);
    }
  } finally {
    running = false;
  }
}

async function runJob(jobId: string) {
  // Mutate to running
  {
    const s = read();
    const j = s.jobs.find((x) => x.id === jobId);
    if (!j || j.status !== "queued") return;
    j.status = "running";
    j.attempts += 1;
    j.updatedAt = new Date().toISOString();
    write(s);
    emit();
  }
  const s0 = read();
  const job = s0.jobs.find((x) => x.id === jobId);
  if (!job) return;

  let dbOk: boolean | undefined;
  let dbError: string | undefined;
  let vpsOk: boolean | undefined;
  let vpsRemoved: string[] = [];
  let vpsErrors: string[] = [];
  let hint: string | undefined;

  try {
    if (job.kind === "project") {
      try {
        await live.admin.projects.remove(job.targetId);
        dbOk = true;
      } catch (e) {
        dbOk = false;
        dbError = e instanceof Error ? e.message : String(e);
      }
      if (dbOk && job.autoPurgeSlug && job.slug) {
        try {
          const mod = await import("./vps-purge.functions");
          const r = await mod.purgeVpsSlug({ data: { slug: job.slug } });
          vpsOk = r.ok;
          vpsRemoved = r.removed ?? [];
          vpsErrors = r.errors ?? [];
          hint = r.hint ?? undefined;
        } catch (e) {
          vpsOk = false;
          vpsErrors = [e instanceof Error ? e.message : String(e)];
        }
      }
    } else {
      try {
        await live.admin.users.remove(job.targetId);
        dbOk = true;
      } catch (e) {
        dbOk = false;
        dbError = e instanceof Error ? e.message : String(e);
      }
    }
  } finally {
    const s = read();
    const j = s.jobs.find((x) => x.id === jobId);
    if (j) {
      const overallOk = dbOk !== false && vpsOk !== false;
      j.status = overallOk ? "ok" : "failed";
      j.dbOk = dbOk;
      j.dbError = dbError;
      j.removed = vpsRemoved;
      j.lastError = dbError ?? (vpsErrors.length ? vpsErrors.join("; ") : undefined);
      j.hint = hint;
      j.updatedAt = new Date().toISOString();
      // On success, drop the soft-delete row.
      if (overallOk) {
        const idx = s.softDeletes.findIndex((x) => x.jobId === jobId);
        if (idx !== -1) s.softDeletes.splice(idx, 1);
      }
      write(s);
      audit({
        actor: j.createdBy,
        action: j.kind === "project" ? "purge_project" : "purge_user",
        targetId: j.targetId,
        targetLabel: j.label,
        dbOk,
        dbError,
        vpsJobId: jobId,
        vpsOk,
        vpsRemoved,
        vpsErrors,
      });
      emit();
    }
  }
}

// Kick a tick on module load so pending jobs resume across reloads.
if (typeof window !== "undefined") {
  scheduleTick(500);
  // Re-check every 15s to catch elapsed windows.
  setInterval(() => scheduleTick(), 15_000);
}
