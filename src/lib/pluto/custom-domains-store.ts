// Per-workspace custom-domain registry, persisted in localStorage.
// Supports A / CNAME / TXT verification, scheduled auto-retry, and SSL probing.
// Backend reconciler (pluto-backend/deploy/reconcile-domains.sh) issues real
// TLS certificates once a row is verified; the SSL probe here just reports
// whether HTTPS on the hostname is already reachable.

export type CustomDomainStatus =
  | "pending"
  | "verifying"
  | "active"
  | "failed"
  | "removing";

export type SslStatus = "unknown" | "pending" | "active" | "failed";

export type DomainRecordType = "A" | "CNAME" | "TXT";

export type CustomDomain = {
  id: string;
  hostname: string;
  slug: string;
  /** DNS record used to verify ownership / routing. */
  recordType: DomainRecordType;
  /** Expected record value: IP for A, target host for CNAME, token for TXT. */
  expectedValue: string;
  /** Legacy: kept for backward-compat with rows created before recordType. */
  targetIp?: string;
  status: CustomDomainStatus;
  lastCheckedAt?: string;
  lastError?: string;
  createdAt: string;

  /** SSL/HTTPS reachability, populated after `probeDomainSsl`. */
  sslStatus?: SslStatus;
  sslCheckedAt?: string;
  sslError?: string;

  /** Scheduler fields — controlled by the panel's auto-retry loop. */
  autoVerify?: boolean;
  nextRetryAt?: string;
  retryCount?: number;
};

const KEY = (workspaceId: string) => `pluto:custom-domains:${workspaceId || "ROOT"}`;

function migrate(row: any): CustomDomain {
  if (row && typeof row === "object" && !row.recordType) {
    return {
      ...row,
      recordType: "A",
      expectedValue: row.expectedValue ?? row.targetIp ?? "",
      sslStatus: row.sslStatus ?? "unknown",
      autoVerify: row.autoVerify ?? true,
    } as CustomDomain;
  }
  return row as CustomDomain;
}

export function loadCustomDomains(workspaceId: string): CustomDomain[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY(workspaceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(migrate) : [];
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

// DNS-over-HTTPS lookup via Google Public DNS. Runs in the browser.
// `type` is the standard record type number: A=1, CNAME=5, TXT=16.
const DNS_TYPE_NUM: Record<DomainRecordType, number> = { A: 1, CNAME: 5, TXT: 16 };

export async function resolveDnsRecords(
  hostname: string,
  type: DomainRecordType,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=${type}`;
  const res = await fetch(url, { signal, headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DNS lookup failed: HTTP ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: Array<{ type: number; data: string }> };
  if (body.Status !== 0) throw new Error(`DNS status ${body.Status ?? "?"}`);
  const wanted = DNS_TYPE_NUM[type];
  return (body.Answer ?? [])
    .filter((a) => a.type === wanted)
    .map((a) => (type === "TXT" ? a.data.replace(/^"|"$/g, "").replace(/"\s*"/g, "") : a.data.replace(/\.$/, "")));
}

// Back-compat helper.
export function resolveARecords(hostname: string, signal?: AbortSignal): Promise<string[]> {
  return resolveDnsRecords(hostname, "A", signal);
}

export type VerifyResult =
  | { ok: true; records: string[] }
  | { ok: false; reason: string; records: string[] };

/** Parse an `expectedValue` into one or more acceptable values.
 *  For TXT we allow multiple entries separated by newlines, commas, or
 *  semicolons — the row matches if ANY parsed value is present in DNS. */
export function parseExpectedValues(type: DomainRecordType, expected: string): string[] {
  if (type !== "TXT") return [expected.trim()].filter(Boolean);
  return expected
    .split(/[\n,;]+/)
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function matches(type: DomainRecordType, expected: string, records: string[]): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\.$/, "");
  const wants = parseExpectedValues(type, expected);
  if (wants.length === 0) return false;
  if (type === "TXT") return wants.some((w) => records.some((r) => r.trim() === w));
  const wantsNorm = wants.map(norm);
  return records.some((r) => wantsNorm.includes(norm(r)));
}

export async function verifyDomainRecord(
  hostname: string,
  type: DomainRecordType,
  expectedValue: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  try {
    const records = await resolveDnsRecords(hostname, type, signal);
    if (records.length === 0) return { ok: false, reason: `No ${type} record found`, records };
    if (!matches(type, expectedValue, records)) {
      return {
        ok: false,
        reason: `${type} record does not match expected "${expectedValue}" (got ${records.join(", ")})`,
        records,
      };
    }
    return { ok: true, records };
  } catch (e) {
    return { ok: false, reason: (e as Error).message, records: [] };
  }
}

// Back-compat wrapper used by earlier callers.
export async function verifyDomainDns(
  hostname: string,
  targetIp: string,
  signal?: AbortSignal,
): Promise<VerifyResult> {
  return verifyDomainRecord(hostname, "A", targetIp, signal);
}

/**
 * Probe HTTPS reachability of a hostname. Browsers hide TLS internals, so this
 * uses `no-cors` mode and treats any non-network error as reachable (the TLS
 * handshake and HTTP response happened). A network error means either DNS
 * failure, connection refused, or a TLS error the browser rejected.
 */
export async function probeDomainSsl(hostname: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetch(`https://${hostname}/`, { method: "HEAD", mode: "no-cors", signal, cache: "no-store" });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message || "TLS/HTTPS unreachable" };
  }
}

// Exponential backoff for scheduled auto-retry.
// 1m, 2m, 5m, 10m, 30m, 60m (capped).
const BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60];
export function nextRetryDelayMs(retryCount: number): number {
  const mins = BACKOFF_MINUTES[Math.min(retryCount, BACKOFF_MINUTES.length - 1)];
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.round(mins * 60_000 * jitter);
}
