/**
 * Public types for the Advanced Auth module (Phase 15).
 * Kept in a separate file so the SDK generator can pick them up
 * independent of the Fastify handler wiring.
 */

export type MfaFactorType = "totp" | "webauthn";

export type MfaFactor = {
  id: string;
  factor_type: MfaFactorType;
  friendly_name: string | null;
  status: "unverified" | "verified" | "revoked";
  created_at: string;
  last_used_at: string | null;
};

export type MfaEnrollResponse = {
  factor_id: string;
  factor_type: MfaFactorType;
  /** otpauth:// URI — render as QR code. Only returned once. */
  otpauth_url: string;
  /** Base32 shared secret. Only returned once. Users copy for manual entry. */
  secret: string;
};

export type MfaChallengeResponse = {
  challenge_id: string;
  expires_at: string;
};

export type SsoProtocol = "oidc" | "saml";

export type SsoProvider = {
  id: string;
  slug: string;
  display_name: string;
  protocol: SsoProtocol;
  enabled: boolean;
  config: Record<string, unknown>;   // secrets scrubbed by the server
  created_at: string;
};

export type PushDevicePlatform = "ios" | "android" | "web";

export type PushDeviceRegister = {
  platform: PushDevicePlatform;
  token: string;
  bundle_id?: string;
  app_version?: string;
};

export type PushMessage = {
  id: string;
  device_id: string | null;
  title: string | null;
  body: string | null;
  data: Record<string, unknown>;
  status: "queued" | "delivered" | "failed";
  error: string | null;
  created_at: string;
  delivered_at: string | null;
};

export const MFA_ISSUER_DEFAULT = "Pluto BaaS";
