// Server-only shared status tracker for the Pluto proxy.
// Keeps last error / success timestamps so /api/pluto/status can report
// upstream health without making an extra probe on every request.
export type PlutoStatus = {
  configured: boolean;
  upstreamUrl: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  lastPath: string | null;
};

const state: PlutoStatus = {
  configured: false,
  upstreamUrl: null,
  lastOkAt: null,
  lastErrorAt: null,
  lastError: null,
  lastPath: null,
};

export function recordSuccess(path: string) {
  state.lastOkAt = Date.now();
  state.lastPath = path;
}

export function recordError(path: string, error: string) {
  state.lastErrorAt = Date.now();
  state.lastError = error;
  state.lastPath = path;
}

export function getStatus(): PlutoStatus {
  const upstream = process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud";
  state.configured = Boolean(upstream);
  state.upstreamUrl = upstream;
  return { ...state };
}

/**
 * Validate the Pluto secrets. Returns a list of issues; empty = OK.
 */
export function validateSecrets(): string[] {
  const issues: string[] = [];
  const url = process.env.PLUTO_UPSTREAM_URL ?? "https://api.timescard.cloud";
  if (!url) {
    issues.push("PLUTO_UPSTREAM_URL is not set. Add it in Lovable project secrets, e.g. https://api.yourdomain.com");
  } else {
    try {
      const u = new URL(url);
      if (!/^https?:$/.test(u.protocol)) {
        issues.push(`PLUTO_UPSTREAM_URL must use http/https (got ${u.protocol})`);
      }
      if (u.pathname !== "/" && u.pathname !== "") {
        issues.push(`PLUTO_UPSTREAM_URL should be an origin without a path (got path "${u.pathname}")`);
      }
    } catch {
      issues.push(`PLUTO_UPSTREAM_URL is not a valid URL: "${url}"`);
    }
  }
  return issues;
}
