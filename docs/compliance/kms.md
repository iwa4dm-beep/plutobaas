# KMS + key rotation

Pluto tracks every cryptographic key it uses in
`public.kms_key_versions`. Each row records the purpose, algorithm,
version number, public JWK (for asymmetric keys), and the wrapped data
encryption key (DEK) for symmetric keys. Only the KMS root wraps
DEKs — Pluto never persists a raw symmetric key.

## Purposes

| Purpose | Algo | Rotation cadence | Blast radius on compromise |
|---|---|---|---|
| `jwt` | ES256 (Ed25519 fallback) | 90 d | Session forgery until revoke |
| `session` | HS256 | 30 d | Session forgery until revoke |
| `encryption` | AES-256-GCM | 180 d | Encrypted secret disclosure |
| `webhook` | HMAC-SHA256 | 365 d | Webhook forgery |

## Rotation

```bash
curl -X POST /compliance/v1/kms/rotate \
  -H "x-service-role-key: $SR" \
  -d '{"purpose":"jwt","algo":"ES256","public_jwk":{...}}'
```

The endpoint marks all previous versions of that purpose inactive and
inserts a new active version. Consumers must:

1. Always verify against every non-expired version, not just the
   `active` one. Expired = rotated more than
   `retention_days_for_purpose` ago.
2. Sign new tokens only with the `active` version.

## Customer-managed keys (roadmap)

The `wrapped_dek` column exists so a future release can rewrap keys
under a customer-supplied KMS root (AWS KMS, GCP KMS, HashiCorp Vault
Transit). The wire format will be `kms://<provider>/<key-id>` in
`wrapped_dek`.
