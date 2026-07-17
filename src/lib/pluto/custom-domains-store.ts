// Per-workspace custom-domain registry, persisted in localStorage.
// Keeps Phase 5 UI self-contained; backend reconciler lives in
// pluto-backend/deploy/reconcile-domains.sh and is orthogonal.

export type CustomDomainStatus =
  | "pending"
  | "verifying"
  | "active"
  | "failed"
  | "removing";

export type CustomDomain = {
  id: string;
  hostname: string;
  slug: string;
  targetIp: string;
  status: CustomDomainStatus;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;
};

const KEY = (workspaceId: string) => `pluto:custom-domains:${workspaceId || "ROOT"}`;

export function loadCustomDomains(workspaceId: string): CustomDomain[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CustomDomain[]) : [];
  } catch {
    return [];
  }
}

export function saveCustomDomains(workspaceId: string, rows: CustomDomain[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY(workspaceId), JSON.stringify(rows));
  window.dispatchEvent(new CustomEvent("pluto:custom-domains:changed", { detail: { workspaceId } }));
}

export function upsertCustomDomain(workspaceId: string, row: CustomDomain): void {
  const rows = loadCustomDomains(workspaceId);
  const i = rows.findIndex((r) => r.id === row.id);
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  saveCustomDomains(workspaceId, rows);
}

export function removeCustomDomain(workspaceId: string, id: string): void {
  saveCustomDomains(workspaceId, loadCustomDomains(workspaceId).filter((r) => r.id !== id));
}

export function newDomainId(): string {
  return `dom_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function isValidHostname(h: string): boolean {
  return HOSTNAME_RE.test(h.trim());
}

// DNS-over-HTTPS lookup via Google Public DNS. Runs entirely in the browser;
// no backend call. Returns the list of A records for the hostname.
export async function resolveARecords(hostname: string, signal?: AbortSignal): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`;
  const res = await fetch(url, { signal, headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DNS lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  if (body.Status !== 0) throw new Error(`DNS status ${body.Status ?? "?"}`);
  return (body.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
}

export type VerifyResult =
  | { ok: true; records: string[] }
  | { ok: false; reason: string; records: string[] };

export async function verifyDomainDns(
  hostname: string,
  targetIp: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  try {
    const records = await resolveARecords(hostname, signal);
    if (records.length === 0) return { ok: false, reason: "No A record found", records };
    if (!records.includes(targetIp)) {
      return { ok: false, reason: `A record does not match target ${targetIp} (got ${records.join(", ")})`, records };
    }
    return { ok: true, records };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, records: [] };
  }
}
