// Server function that probes the VPS backend and returns a compact health
// report the dashboard can render. Uses no auth — hits public health paths.
import { createServerFn } from "@tanstack/react-start";
import { getVpsBaseUrl } from "./vps-client";

export type VpsHealthProbe = {
  path: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  body?: unknown;
  error?: string;
};

export type VpsHealthReport = {
  baseUrl: string;
  checkedAt: string;
  serviceKeyConfigured: boolean;
  probes: VpsHealthProbe[];
  healthy: boolean;
};

async function probe(base: string, path: string): Promise<VpsHealthProbe> {
  const started = Date.now();
  try {
    const res = await fetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    let body: unknown = null;
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : null;
    } catch { /* ignore parse */ }
    return { path, ok: res.ok, status: res.status, latencyMs: Date.now() - started, body };
  } catch (e) {
    return {
      path, ok: false, status: 0, latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export const checkVpsHealth = createServerFn({ method: "GET" }).handler(async (): Promise<VpsHealthReport> => {
  const base = getVpsBaseUrl();
  const paths = ["/livez", "/readyz", "/health/deps", "/"];
  const probes = await Promise.all(paths.map((p) => probe(base, p)));
  return {
    baseUrl: base,
    checkedAt: new Date().toISOString(),
    serviceKeyConfigured: Boolean(process.env.PLUTO_SERVICE_ROLE_KEY),
    probes,
    healthy: probes.filter((p) => p.path !== "/").every((p) => p.ok),
  };
});
