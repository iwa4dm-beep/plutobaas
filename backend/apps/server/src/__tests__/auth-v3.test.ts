// Phase 50 — Auth v3 unit tests (pure libs, no DB).

import { describe, it, expect } from "vitest";
import { scoreSession, deviceHash } from "../lib/risk-score.js";
import {
  buildRegistrationOptions, buildAuthenticationOptions,
  checkAssertionCounter, newChallenge, b64url,
} from "../lib/webauthn.js";
import { generateTotpSecret, totpCode, verifyTotp, base32Decode } from "../lib/totp.js";

describe("risk scoring", () => {
  it("low risk when device+network are known", () => {
    const r = scoreSession({
      known_device: true, same_ip_asn: true, new_country: false,
      impossible_travel: false, failed_attempts_15m: 0, tor_or_vpn: false,
    });
    expect(r.band).toBe("low");
    expect(r.step_up_required).toBe(false);
  });
  it("step-up required for new device + new country", () => {
    const r = scoreSession({
      known_device: false, same_ip_asn: false, new_country: true,
      impossible_travel: false, failed_attempts_15m: 0, tor_or_vpn: false,
    });
    expect(r.band).not.toBe("low");
    expect(r.step_up_required).toBe(true);
    expect(r.reasons).toContain("new_device");
    expect(r.reasons).toContain("new_country");
  });
  it("impossible travel + brute force → high", () => {
    const r = scoreSession({
      known_device: false, same_ip_asn: false, new_country: true,
      impossible_travel: true, failed_attempts_15m: 8, tor_or_vpn: true,
    });
    expect(r.band).toBe("high");
    expect(r.score).toBeGreaterThanOrEqual(60);
  });
  it("deviceHash is stable for identical signals", () => {
    const a = deviceHash({ user_agent: "UA/1", accept_language: "en", platform: "mac" });
    const b = deviceHash({ user_agent: "UA/1", accept_language: "en", platform: "mac" });
    expect(a).toBe(b);
    const c = deviceHash({ user_agent: "UA/2", accept_language: "en", platform: "mac" });
    expect(a).not.toBe(c);
  });
});

describe("webauthn primitives", () => {
  it("registration options include ES256 + RS256 algorithms", () => {
    const o = buildRegistrationOptions({
      rp_id: "example.com", rp_name: "Ex",
      user_id: "u", user_name: "u", user_display: "u",
    });
    expect(o.pubKeyCredParams.map((p) => p.alg).sort()).toEqual([-257, -7]);
    expect(o.challenge.length).toBeGreaterThan(20);
  });
  it("authentication options list allowed credentials", () => {
    const o = buildAuthenticationOptions({
      rp_id: "example.com",
      allow: [{ credential_id: "abc", transports: ["usb"] }],
    });
    expect(o.allowCredentials[0].id).toBe("abc");
    expect(o.allowCredentials[0].transports).toEqual(["usb"]);
  });
  it("counter regression is rejected (clone protection)", () => {
    expect(checkAssertionCounter(10, 9)).toBeNull();
    expect(checkAssertionCounter(10, 10)).toBeNull();
    expect(checkAssertionCounter(10, 11)).toBe(11);
    expect(checkAssertionCounter(0, 0)).toBe(0);
  });
  it("challenges are unique random strings", () => {
    const a = newChallenge(), b = newChallenge();
    expect(a).not.toBe(b);
  });
  it("b64url is URL-safe", () => {
    const s = b64url(Buffer.from([255, 254, 253]));
    expect(s).not.toMatch(/[+/=]/);
  });
});

describe("totp flow", () => {
  it("generates a base32 secret and verifies current code", () => {
    const { secret_b32, secret_bytes } = generateTotpSecret();
    expect(secret_b32.length).toBeGreaterThan(20);
    const code = totpCode(secret_bytes);
    expect(verifyTotp(base32Decode(secret_b32), code)).toBe(true);
  });
  it("rejects wrong code", () => {
    const { secret_bytes, secret_b32 } = generateTotpSecret();
    const wrong = totpCode(secret_bytes) === "000000" ? "111111" : "000000";
    expect(verifyTotp(base32Decode(secret_b32), wrong)).toBe(false);
  });
});
