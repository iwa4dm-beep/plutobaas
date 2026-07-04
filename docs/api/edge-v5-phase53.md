# Edge v5 — Phase 53

Adds a WebAssembly runtime tier for edge functions with warm-instance pooling,
per-region deployments, and custom-domain attachment. Enable with
`PLUTO_ENABLE_EDGE_V5=1`.

## Endpoints

All routes require an API key. Mount prefix: `/fn/v5`.

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/fn/v5/modules` | Register a WASM module (`wasm_base64`, ≤20 MiB) |
| GET  | `/fn/v5/modules` | List registered modules |
| POST | `/fn/v5/deployments` | Deploy a module to a region (`min_warm`, `max_warm`) |
| POST | `/fn/v5/invoke` | Invoke by (module, version) + `client_region`; response reports `cold` |
| POST | `/fn/v5/domains` | Attach a custom hostname; returns `verify_txt` |
| GET  | `/fn/v5/domains` | List custom domains |

## Cold-start reduction

The warm pool pre-instantiates `min_warm` instances per
`(module@version, region)` key. `acquire()` returns warm instances first;
only when the pool is empty is a fresh instance created and reported as
`cold: true`. Freed instances are returned to the pool up to `max_warm`.

## Region routing

`pickDeployment(deps, clientRegion)` looks up neighbor lists (e.g.
`eu-central → eu-west`) so an invocation without an exact-region deployment
still lands close. Non-`active` deployments are skipped.

## Data model

Migration `0051_phase53_edge_v5.sql` adds:
- `edge5_wasm_modules` — content-addressed WASM bytes
- `edge5_deployments` — module × region assignments and pool caps
- `edge5_domains` — custom hostnames with cert-issuance status
- `edge5_invocations` — per-call telemetry for cold-start dashboards

All tables are workspace-scoped with RLS via `public.current_workspace_id()`.
