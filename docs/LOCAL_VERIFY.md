# Local Boot Verification — Troubleshooting Checklist

The one command that does everything:

```bash
cd backend && chmod +x scripts/verify-all.sh && ./scripts/verify-all.sh
```

If it passes, your local backend is fully wired. If it fails, walk the
checklist below — each section maps to a phase of `verify-all.sh` and
starts with the error string you'll actually see.

---

## Phase 1 — Preflight

### `docker not installed` / `docker compose plugin missing`
- macOS: install **Docker Desktop** (`brew install --cask docker`)
- Linux: `curl -fsSL https://get.docker.com | sh` then `sudo usermod -aG docker $USER` and re-login
- Verify: `docker compose version` must print `Docker Compose version v2.x`

### `bun not installed`
```bash
curl -fsSL https://bun.sh/install | bash
exec $SHELL
```

### `port 3000/5433/9000 already bound`
Something is squatting the port. Find and kill:
```bash
lsof -iTCP:3000 -sTCP:LISTEN                 # find pid
kill <pid>                                    # or use a different PORT
```
Or override:
```bash
PORT=3001 ./scripts/verify-all.sh
```

---

## Phase 2 — Postgres + MinIO

### `postgres never became healthy`
- Check container: `docker compose logs db | tail -30`
- Common cause: stale volume with an older Postgres version.
  Reset: `docker compose down -v && ./scripts/verify-all.sh` (⚠ wipes data)
- Firewall / VPN sometimes blocks `127.0.0.1:5433` — pause VPN and retry

### `minio never became healthy`
- `docker compose logs minio | tail -30`
- Usually a disk-full or permission issue on the docker volume
- Free space: `docker system prune -a --volumes` (⚠ wipes all unused images)

---

## Phase 3 — Install + Migrate

### `deps installed` hangs > 60s
- Bun's cache may be corrupted: `rm -rf ~/.bun/install/cache && bun install`
- Behind a corporate proxy? `export HTTPS_PROXY=http://proxy:port`

### `migrations failed — see /tmp/pluto-migrate.log`
Read the log — the last 20 lines almost always say exactly which
migration and which SQL statement blew up. Common cases:

| Message | Fix |
|---|---|
| `relation "…" already exists` | Old data — `docker compose down -v` and rerun |
| `extension "vector" is not available` | Postgres image missing pgvector. The compose file uses `postgres:16-alpine` which doesn't include it. For Vector v3 locally either switch to `pgvector/pgvector:pg16` in `docker-compose.yml` or set `PLUTO_ENABLE_VECTOR_V3=0` |
| `must be superuser to create extension` | You pointed `DATABASE_URL` at a shared cluster. Use the local compose DB |
| `password authentication failed` | You edited `.env` — make sure `DATABASE_URL` matches the compose creds (`pluto:pluto`) |
| Node error `Cannot find module 'dist/db/migrate.js'` | You're using compiled path. `bun run migrate` uses tsx and works from src — that's what `verify-all.sh` calls |

---

## Phase 4 — Server boot

### `server never returned /readyz 200`
Open `/tmp/pluto-verify.log` — the boot error is at the bottom.

| Symptom | Cause | Fix |
|---|---|---|
| `Cannot find module './modules/logs/plugin.js'` | Wave 1 stub missing | Already patched — pull latest |
| `EADDRINUSE :3000` | Another server on the port | See Phase 1 port fix |
| `password authentication failed for user "pluto"` | DB creds mismatch | Ensure env exports match compose |
| `Client has encountered a connection error and is not queryable` | Postgres died mid-boot | `docker compose logs db` |
| `S3ServiceException: Access Denied` | MinIO creds mismatch | Env exports must match `minio/minio1234` |
| Hangs > 40s with no error | Plugin waiting on external service (SMTP, Redis) | Check log for `waiting for …` and disable that feature flag |

Manual boot to see live output:
```bash
cd backend/apps/server
DATABASE_URL=postgres://pluto:pluto@localhost:5433/pluto \
  JWT_SECRET=x ANON_KEY=x SERVICE_ROLE_KEY=x \
  bun run dev
```

---

## Phase 5 — Endpoint smoke tests

Each `hit` line accepts a **set of acceptable status codes**. If a check
fails, `curl` output is dumped after the `✗`. Common patterns:

| Failure | Meaning | Fix |
|---|---|---|
| `→ got 000` | curl couldn't connect | Server crashed after `/readyz` — check `/tmp/pluto-verify.log` |
| `→ got 401` but 401 not in want-list | apikey header missing / wrong | Verify `ANON_KEY` / `SERVICE_ROLE_KEY` env exports |
| `→ got 500` on `/rest/v4/*` | RPC registry empty for the workspace | Expected on a fresh DB — check for `unhandled` error in log |
| `→ got 400` on realtime publish | schema drift | Check `docs/api/realtime-v5-phase60.md` for current payload shape |
| `→ got 404` on `/edge/v7/functions` | edge_v7 plugin gated off | Set `PLUTO_ENABLE_EDGE_V7=1` |
| `/metrics` returns 404 | observability disabled | `PLUTO_ENABLE_OBSERVABILITY=1` (already exported) |

---

## Phase 6 — After a green run

- Leave the stack up for interactive testing:
  ```bash
  KEEP_RUNNING=1 ./scripts/verify-all.sh
  ```
- Hit the frontend demo: open `/dashboard/sdk-demo` with
  `VITE_PLUTO_URL=http://localhost:3000` in your `.env`.
- Tear down when done:
  ```bash
  cd backend && docker compose down          # keep volumes
  docker compose down -v                     # nuke everything
  ```

---

## Getting more signal

- **Structured server log**: `tail -f /tmp/pluto-verify.log | jq .`
- **DB shell**: `docker compose exec db psql -U pluto -d pluto`
- **List migrations applied**: `SELECT version, name, applied_at FROM schema_migrations ORDER BY version;`
- **List MinIO objects**: open `http://localhost:9001` (creds `minio` / `minio1234`)
- **Reset everything and start over**:
  ```bash
  cd backend && docker compose down -v && rm -rf apps/server/node_modules
  ./scripts/verify-all.sh
  ```

If `verify-all.sh` still fails after walking this checklist, paste the
last 60 lines of `/tmp/pluto-verify.log` and the failing `hit` output
back to Lovable — that's enough signal to debug in one turn.
