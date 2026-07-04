# SOC2 program (in-progress)

Pluto targets SOC2 Type II. This document tracks which controls are
implemented, which are policy-only, and which are open. It is a living
record — see the linked docs for the technical detail behind each row.

| Control area | Status | Where |
|---|---|---|
| Access control (RBAC + workspace isolation) | Implemented | `docs/security/core-tables-rls.md`, `/dashboard/rbac` |
| Least-privilege service accounts | Implemented | migration `0029_core_grants_lockdown.sql` |
| Encryption at rest (DB) | Managed by hosting provider | KMS ledger: `docs/compliance/kms.md` |
| Encryption in transit | Enforced (Caddy TLS 1.3) | `backend/Caddyfile` |
| Audit logging | Implemented | module `observability`, `/obs/v1/audit` |
| Backup + PITR | Implemented | `docs/api/billing-pitr.md` |
| Cross-region DR | Implemented (control plane) | migration `0036_pitr.sql` + `pitr/plugin.ts` |
| Right to delete (GDPR Art. 17) | Implemented | `/compliance/v1/delete-me` |
| Data portability (GDPR Art. 20) | Implemented | `/compliance/v1/export-me` |
| Data residency | Implemented | `docs/compliance/data-residency.md` |
| Key rotation | Implemented | `/compliance/v1/kms/rotate` |
| Vulnerability scanning | Partial (CI: npm audit) | `.github/workflows/ci.yml` |
| Penetration testing | Policy-only | third-party engagement TBD |
| Incident response runbook | Draft | `docs/status.md` |
| Business continuity plan | Draft | this document |
| Vendor risk management | Not started | — |

## Evidence collection

- Every migration is versioned in `backend/apps/server/src/db/migrations/`.
- Every admin action hits `/obs/v1/audit` (retention: 400d).
- KMS rotations write to `kms_key_versions` (append-only).
- GDPR delete requests write to `gdpr_delete_requests` (append-only).

## Open questions before Type I audit

1. Formal vendor list (Stripe, Twilio, SMTP provider, hosting).
2. Incident response drill cadence.
3. Encryption-key custody model — customer-managed vs Pluto-managed.
