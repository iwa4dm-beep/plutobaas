# Local dev stack

Everything you need to run Pluto end-to-end on a laptop.

## Prereqs

- Node 20+ and Bun (or npm)
- Docker (for Postgres + optional MinIO)
- A copy of `backend/.env.local.example` → `backend/apps/server/.env`

## One-shot

```bash
# Postgres + object store
docker compose -f backend/docker-compose.yml up -d

# Apply migrations (0001 → latest)
cd backend/apps/server && bun install && bun run migrate

# Start the API
bun run dev
# → http://localhost:8080

# In another terminal, start the dashboard
cd ../../.. && bun install && bun run dev
# → http://localhost:5173
```

## Feature flags

Every post-Phase-30 feature is opt-in. Copy the flags you need into
`backend/apps/server/.env`:

```
PLUTO_ENABLE_AUTH_COMPLETION=1
PLUTO_ENABLE_IMAGE_TRANSFORM=1
PLUTO_ENABLE_TUS=1
PLUTO_ENABLE_CDC=1
PLUTO_ENABLE_DATA_API=1
PLUTO_ENABLE_EDGE_V3=1
PLUTO_ENABLE_BILLING=1
PLUTO_ENABLE_PITR=1
PLUTO_ENABLE_COMPLIANCE=1
PLUTO_ENABLE_OBSERVABILITY=1
```

## Email in dev

Without `SMTP_HOST` set, the auth flows use the `console` email
adapter — reset/confirm/OTP links print to the server logs. Wire real
SMTP with:

```
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Pluto <no-reply@example.com>"
```

## Smoke test

```bash
curl http://localhost:8080/healthz
curl http://localhost:8080/readyz
curl -H "apikey: $PLUTO_ANON_KEY" http://localhost:8080/rest/v1/     # OpenAPI doc
curl http://localhost:8080/metrics                                    # Prometheus
```
