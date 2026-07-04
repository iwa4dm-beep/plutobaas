# Pluto Docs

Living documentation for the Pluto BaaS. Grouped by API surface — each
file is a self-contained reference including request/response shapes,
error codes, and enable flags.

## Guides
- [Local dev stack](./local-dev.md)
- [Core tables RLS/GRANT](./security/core-tables-rls.md)

## API reference
- [Auth](./api/auth.md) — sign-up, sign-in, password reset, OTP, OAuth
- [Data API (REST + GraphQL)](./api/data-api.md) — auto-generated CRUD
- [Storage](./api/storage.md) — objects, signed URLs, image transforms, TUS
- [Realtime CDC](./api/realtime-cdc.md) — Postgres change feeds
- [Edge Functions v3](./api/edge-v3.md) — hardened isolate runtime
- [Billing & PITR](./api/billing-pitr.md) — Stripe + point-in-time recovery
- [Tokens & Logs](./api/tokens-and-logs.md) — API keys + log stream SSE

## Compliance
- [SOC2 program](./compliance/soc2.md)
- [Data residency](./compliance/data-residency.md)
- [KMS + key rotation](./compliance/kms.md)

## Status
- [Service status](./status.md) — regions, uptime targets, incident policy
