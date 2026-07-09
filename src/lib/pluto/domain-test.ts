/**
 * DNS + healthcheck utilities for custom-domain verification.
 *
 * Uses Cloudflare's public DNS-over-HTTPS resolver so the browser can
 * check propagation without any backend involvement. The healthcheck
 * probes `https://<host>/health` (falls back to `/`), with a short
 * timeout and CORS-tolerant `no-cors` fallback.
 */

const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

export type DnsRecord = { type: string; name: string; data: string };

export type DomainTestResult = {
  hostname: string;
  isWildcard: boolean;
  dns: {
    a: DnsRecord[];
    aaaa: DnsRecord[];
    cname: DnsRecord[];
    txt: DnsRecord[];
    error?: string;
  };
  verifyTxt: {
    expectedName: string;
    expectedValue: string | null;
    found: boolean;
    values: string[];
  };
  health: {
    url: string;
    ok: boolean;
    status: number | null;
    ms: number;
    error?: string;
  };
};

async function dohLookup(name: string, type: string): Promise<DnsRecord[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await fetch(url, { headers: { Accept: "application/dns-json" } });
  if (!res.ok) throw new Error(`DoH ${type} ${res.status}`);
  const body = (await res.json()) as { Answer?: Array<{ type: number; name: string; data: string }> };
  const answers = body.Answer ?? [];
  return answers.map((a) => ({ type, name: a.name, data: a.data.replace(/^"|"$/g, "") }));
}

async function probeHealth(hostname: string, timeoutMs = 4000): Promise<DomainTestResult["health"]> {
  const target = hostname.startsWith("*.")
    ? `https://test.${hostname.slice(2)}/health`
    : `https://${hostname}/health`;

  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(target, { method: "GET", mode: "cors", signal: controller.signal });
    clearTimeout(timer);
    return { url: target, ok: res.ok, status: res.status, ms: Math.round(performance.now() - started) };
  } catch (err) {
    clearTimeout(timer);
    // Fallback: try no-cors so we at least know it's reachable.
    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), timeoutMs);
      await fetch(target, { method: "GET", mode: "no-cors", signal: controller2.signal });
      clearTimeout(timer2);
      return {
        url: target,
        ok: true,
        status: null,
        ms: Math.round(performance.now() - started),
        error: "reachable (opaque CORS response)",
      };
    } catch (err2) {
      return {
        url: target,
        ok: false,
        status: null,
        ms: Math.round(performance.now() - started),
        error: (err2 as Error).message || (err as Error).message,
      };
    }
  }
}

export function isWildcardHostname(host: string): boolean {
  return host.startsWith("*.");
}

/** Returns the DNS record label a caller must place the ACME/verify TXT under. */
export function verifyTxtRecordName(hostname: string): string {
  if (isWildcardHostname(hostname)) {
    // ACME DNS-01 for wildcards: `_acme-challenge.<apex-or-parent>`
    return `_acme-challenge.${hostname.slice(2)}`;
  }
  return `_pluto-verify.${hostname}`;
}

export async function testDomainEndpoint(
  hostname: string,
  expectedTxt?: string | null,
): Promise<DomainTestResult> {
  const wildcard = isWildcardHostname(hostname);
  const dnsBase = wildcard ? hostname.slice(2) : hostname;

  const dns: DomainTestResult["dns"] = { a: [], aaaa: [], cname: [], txt: [] };
  try {
    const [a, aaaa, cname, txt] = await Promise.all([
      dohLookup(dnsBase, "A").catch(() => []),
      dohLookup(dnsBase, "AAAA").catch(() => []),
      dohLookup(dnsBase, "CNAME").catch(() => []),
      dohLookup(verifyTxtRecordName(hostname), "TXT").catch(() => []),
    ]);
    dns.a = a;
    dns.aaaa = aaaa;
    dns.cname = cname;
    dns.txt = txt;
  } catch (e) {
    dns.error = (e as Error).message;
  }

  const values = dns.txt.map((r) => r.data);
  const found = expectedTxt ? values.some((v) => v.includes(expectedTxt)) : values.length > 0;

  const health = await probeHealth(hostname);

  return {
    hostname,
    isWildcard: wildcard,
    dns,
    verifyTxt: {
      expectedName: verifyTxtRecordName(hostname),
      expectedValue: expectedTxt ?? null,
      found,
      values,
    },
    health,
  };
}
