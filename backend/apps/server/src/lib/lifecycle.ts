// Phase 49 — Lifecycle rule evaluator.
//
// Pure functions: caller supplies the candidate object list and the rule,
// and receives the subset that must be acted on. Actions are performed by
// the plugin (delete for `expire`, storage-class change for `tier`, DELETE
// on st3_upload_sessions for `abort_incomplete`).

export type LifecycleAction = "expire" | "tier" | "abort_incomplete";

export type LifecycleRule = {
  id: string;
  bucket: string;
  prefix: string;
  action: LifecycleAction;
  after_days: number;
  target_tier?: string | null;
  enabled: boolean;
};

export type ObjectRow = {
  bucket: string;
  key: string;
  created_at: number;   // epoch ms
  storage_tier?: string | null;
};

export function matchesRule(obj: ObjectRow, rule: LifecycleRule, now = Date.now()): boolean {
  if (!rule.enabled) return false;
  if (obj.bucket !== rule.bucket) return false;
  if (rule.prefix && !obj.key.startsWith(rule.prefix)) return false;
  const ageDays = (now - obj.created_at) / 86_400_000;
  if (ageDays < rule.after_days) return false;
  if (rule.action === "tier" && rule.target_tier && obj.storage_tier === rule.target_tier) return false;
  return true;
}

export function evaluateRule(objects: ObjectRow[], rule: LifecycleRule, now = Date.now()) {
  const matched = objects.filter((o) => matchesRule(o, rule, now));
  return { matched, count: matched.length };
}
