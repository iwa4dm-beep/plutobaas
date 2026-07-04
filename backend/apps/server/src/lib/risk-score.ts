// Phase 50 — Session risk scoring.
// Pure functions so tests can exercise the scoring model without a DB.

export type RiskSignals = {
  known_device: boolean;      // device_hash seen for this user before
  same_ip_asn: boolean;       // IP in the same /24 (proxy for ASN) as prior sessions
  new_country: boolean;       // geo-ip country differs from last known
  impossible_travel: boolean; // > 500km/h between last session and current
  failed_attempts_15m: number;
  tor_or_vpn: boolean;
};

export type RiskScore = {
  score: number;               // 0..100
  band: "low" | "medium" | "high";
  step_up_required: boolean;
  reasons: string[];
};

export function scoreSession(sig: RiskSignals): RiskScore {
  let score = 0;
  const reasons: string[] = [];

  if (!sig.known_device)      { score += 25; reasons.push("new_device"); }
  if (!sig.same_ip_asn)       { score += 10; reasons.push("new_network"); }
  if (sig.new_country)        { score += 25; reasons.push("new_country"); }
  if (sig.impossible_travel)  { score += 40; reasons.push("impossible_travel"); }
  if (sig.tor_or_vpn)         { score += 15; reasons.push("anonymizing_network"); }
  if (sig.failed_attempts_15m >= 5) { score += 20; reasons.push("brute_force_suspect"); }
  else if (sig.failed_attempts_15m >= 2) { score += 5; reasons.push("recent_failures"); }

  score = Math.min(100, score);
  const band = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  const step_up_required = band !== "low";
  return { score, band, step_up_required, reasons };
}

// Stable fingerprint of a device from request headers. Not privacy-invasive:
// only combines the values the client already sends on every request.
import { createHash } from "node:crypto";
export function deviceHash(input: { user_agent?: string; accept_language?: string; platform?: string }): string {
  const s = `${input.user_agent ?? ""}|${input.accept_language ?? ""}|${input.platform ?? ""}`;
  return createHash("sha256").update(s).digest("hex");
}
