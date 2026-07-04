// Phase 54 — Retention locks with governance/compliance modes and legal holds.
// - compliance mode: even workspace admins cannot shorten or bypass.
// - governance mode: can be overridden by callers holding a bypass flag.
// - legal_hold: overrides retain_until until explicitly cleared.

export type RetentionMode = "governance" | "compliance";
export type Lock = { mode: RetentionMode; retain_until: number; legal_hold: boolean };

const locks = new Map<string, Lock>(); // key = `${bucket}/${object}/${version}`
const lkey = (b: string, k: string, v: string) => `${b}/${k}/${v}`;

export function setLock(bucket: string, key: string, version_id: string, next: Lock): Lock {
  const cur = locks.get(lkey(bucket, key, version_id));
  if (cur) {
    if (cur.mode === "compliance") {
      // Compliance locks can only be extended, never shortened or downgraded.
      if (next.retain_until < cur.retain_until) throw new Error("compliance_lock_shorten");
      if (next.mode !== "compliance") throw new Error("compliance_lock_downgrade");
    }
  }
  const merged: Lock = { ...next, legal_hold: next.legal_hold || (cur?.legal_hold ?? false) };
  locks.set(lkey(bucket, key, version_id), merged);
  return merged;
}

export function getLock(bucket: string, key: string, version_id: string): Lock | undefined {
  return locks.get(lkey(bucket, key, version_id));
}

export function clearLegalHold(bucket: string, key: string, version_id: string): boolean {
  const l = locks.get(lkey(bucket, key, version_id));
  if (!l) return false;
  l.legal_hold = false;
  return true;
}

/** Returns true when the version may be mutated/deleted right now. */
export function canModify(bucket: string, key: string, version_id: string, opts: { bypass_governance?: boolean } = {}): boolean {
  const l = locks.get(lkey(bucket, key, version_id));
  if (!l) return true;
  if (l.legal_hold) return false;
  if (l.retain_until > Date.now()) {
    if (l.mode === "governance" && opts.bypass_governance) return true;
    return false;
  }
  return true;
}

export function clearLocks(): void { locks.clear(); }
