# Edge v5 — Phase 53 (full capability scope)

Enable with `PLUTO_ENABLE_EDGE_V5=1`. All routes require an API key.

## Runtime capability scope

| Capability | Status | Details |
| --- | --- | --- |
| WASM runtime | ✅ | `wasm_base64` upload (≤20 MiB), content-addressed via SHA-256, versioned per module name |
| Warm-instance pool | ✅ | `min_warm`/`max_warm` per `(module@version, region)`; cold-start reported per invocation |
| Per-region deploy | ✅ | Region format `xx-region[-N]`; neighbor fallback (`eu-central → eu-west`, etc.) |
| Custom domains v2 | ✅ | Attach hostname → module; returns TXT verification token; `cert_status` lifecycle |
| Per-function KV | ✅ | Namespace `${workspace}/${module}`, TTL, prefix list, ≤64 KiB values |
| Queue triggers | ✅ | Bind subscribers, enqueue, FIFO drain with re-queue on failure |
| Streaming response | ✅ | `GET /fn/v5/stream?chunks=N` returns `text/event-stream` chunks |
| Invocation telemetry | ✅ | `edge5_invocations` table (region, cold, duration_ms, status) |
| HTTP fetch inside WASM | ⏳ Phase 55 | Requires host-imports interface |
| Durable Objects | ⏳ Phase 56 | Planned alongside replicated KV |

## Endpoint index (mount prefix `/fn/v5`)

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/modules` | Register a WASM module |
| GET  | `/modules` | List registered modules |
| POST | `/deployments` | Deploy `(module, version)` to a region with pool caps |
| POST | `/invoke` | Invoke by `(module, version, client_region)`; reports `cold` + `region` |
| POST | `/domains` | Attach a custom hostname; returns `verify_txt` |
| GET  | `/domains` | List custom domains |
| POST | `/kv/put` | Put a key with optional `ttl_ms` |
| GET  | `/kv/get` | Get a value (404 when missing/expired) |
| DELETE | `/kv` | Delete a key |
| GET  | `/kv/list` | List keys by prefix |
| POST | `/queues/bind` | Bind a `(module, version)` subscriber to a queue |
| POST | `/queues/enqueue` | Enqueue a job body |
| POST | `/queues/drain` | Drain up to `max` jobs; failing subs re-queue |
| GET  | `/stream` | Streaming SSE response (`chunks` query param) |

## Cold-start reduction

`min_warm` pre-instantiates warm instances at deploy time. `acquire()` pops
warm first; only when empty does it create a fresh instance and mark
`cold: true`. `release()` returns instances up to `max_warm`.

## Notes

- All state is process-local for now — multi-node deployments need a shared
  KV/queue backend (roadmap: Phase 55/56).
- The `/fn/v5/invoke` handler simulates execution (no real WebAssembly
  instantiation yet); Phase 55 wires the compiled module cache.
