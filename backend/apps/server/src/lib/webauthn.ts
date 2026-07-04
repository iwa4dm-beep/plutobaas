// Phase 50 — WebAuthn helper primitives.
//
// This is a minimal, dependency-free stub that implements the subset of the
// WebAuthn ceremony surface Pluto needs: challenge generation, credential
// registration bookkeeping, and assertion counter checks. Full attestation
// verification is delegated to `@simplewebauthn/server` when installed; the
// helpers here are safe to unit-test in isolation.

import { randomBytes, createHash } from "node:crypto";

export function b64url(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function newChallenge(): string {
  return b64url(randomBytes(32));
}

export type RegistrationOptions = {
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout: number;
  attestation: "none" | "direct" | "indirect";
  authenticatorSelection: {
    residentKey: "required" | "preferred" | "discouraged";
    userVerification: "required" | "preferred" | "discouraged";
  };
};

export function buildRegistrationOptions(input: {
  rp_id: string; rp_name: string;
  user_id: string; user_name: string; user_display: string;
  challenge?: string;
}): RegistrationOptions {
  return {
    rp: { id: input.rp_id, name: input.rp_name },
    user: { id: input.user_id, name: input.user_name, displayName: input.user_display },
    challenge: input.challenge ?? newChallenge(),
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },   // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    timeout: 60_000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  };
}

export type AuthenticationOptions = {
  challenge: string;
  timeout: number;
  rpId: string;
  userVerification: "required" | "preferred" | "discouraged";
  allowCredentials: { id: string; type: "public-key"; transports?: string[] }[];
};

export function buildAuthenticationOptions(input: {
  rp_id: string;
  challenge?: string;
  allow: { credential_id: string; transports?: string[] }[];
}): AuthenticationOptions {
  return {
    challenge: input.challenge ?? newChallenge(),
    timeout: 60_000,
    rpId: input.rp_id,
    userVerification: "preferred",
    allowCredentials: input.allow.map((c) => ({ id: c.credential_id, type: "public-key", transports: c.transports })),
  };
}

// Basic assertion counter check — sign_count must strictly increase, else the
// credential may be cloned. Return the new counter to persist or null to reject.
export function checkAssertionCounter(prev: number, next: number): number | null {
  if (next === 0 && prev === 0) return 0;         // authenticator that doesn't track
  if (next <= prev) return null;
  return next;
}

// Hash a client-data JSON blob for comparison.
export function clientDataHash(clientDataJson: string): string {
  return createHash("sha256").update(clientDataJson).digest("hex");
}
