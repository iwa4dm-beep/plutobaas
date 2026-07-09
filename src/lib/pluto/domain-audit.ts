/**
 * Client-side audit ledger for custom-domain operations.
 *
 * We persist per-workspace entries to localStorage so the audit trail
 * survives reloads even when the backend audit endpoint is unavailable
 * or filtered. Each entry records who did what, when, and against which
 * hostname — mirroring the schema used by `live.audit`.
 */

export type DomainAuditAction =
  | "domain.add"
  | "domain.verify"
  | "domain.remove"
  | "domain.make_primary"
  | "domain.clear_primary"
  | "domain.test_endpoint";

export type DomainAuditEntry = {
  id: string;
  workspace_id: string;
  actor: string;
  action: DomainAuditAction;
  hostname: string;
  status: "ok" | "error";
  meta?: Record<string, unknown>;
  ts: string; // ISO
};

const STORAGE_PREFIX = "pluto.domain.audit.";
const MAX_ENTRIES = 500;

function keyFor(workspaceId: string): string {
  return STORAGE_PREFIX + workspaceId;
}

function readAll(workspaceId: string): DomainAuditEntry[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(keyFor(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DomainAuditEntry[]) : [];
  } catch {
    return [];
  }
}

export function listDomainAudit(workspaceId: string): DomainAuditEntry[] {
  return readAll(workspaceId).sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export function recordDomainAudit(
  workspaceId: string,
  actor: string,
  action: DomainAuditAction,
  hostname: string,
  status: "ok" | "error",
  meta?: Record<string, unknown>,
): DomainAuditEntry {
  const entry: DomainAuditEntry = {
    id: crypto.randomUUID(),
    workspace_id: workspaceId,
    actor: actor || "unknown",
    action,
    hostname,
    status,
    meta,
    ts: new Date().toISOString(),
  };
  const all = readAll(workspaceId);
  all.push(entry);
  const trimmed = all.slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(keyFor(workspaceId), JSON.stringify(trimmed));
  } catch {
    /* quota exceeded — silently drop */
  }
  return entry;
}

export function clearDomainAudit(workspaceId: string): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(keyFor(workspaceId));
}
