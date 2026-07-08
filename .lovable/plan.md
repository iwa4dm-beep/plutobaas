# Database Import & Connect Suite — Pluto Admin

আপনার সমস্যা: admin dashboard থেকে database add / import / connect করা যাচ্ছে না। সমাধানে দুই স্তরে কাজ হবে — **Backend (Pluto API on VPS)** এ নতুন endpoints, এবং **Frontend (Lovable admin dashboard)** এ নতুন UI।

---

## 1. Backend — নতুন Endpoints (`pluto-backend/packages/api/src/routes/dbio.ts`)

Superadmin-only, `/admin/v1/dbio/*` prefix।

| Endpoint | কাজ |
|---|---|
| `POST /connections/test` | Host/port/user/pass/dbname/ssl দিয়ে MySQL/Postgres/SQLite connection test |
| `POST /connections` | External DB connection save (encrypted, `admin.db_connections` table এ) |
| `GET  /connections` | Saved connections list |
| `DELETE /connections/:id` | Remove |
| `POST /import/schema` | `.sql` schema file upload → target schema এ execute (DDL only, transactional) |
| `POST /import/dump` | MySQL/Postgres dump file (`.sql`, `.sql.gz`) upload → auto-detect dialect → convert MySQL→PG syntax → execute |
| `POST /import/csv` | CSV → new/existing table (header auto-detect, type inference) |
| `POST /import/mysql-live` | Saved MySQL connection থেকে সরাসরি pull → convert → load |
| `GET  /import/jobs/:id` | Streaming progress (SSE): parsed statements, applied, failed |
| `POST /export/mysqldump` | Postgres schema → MySQL-compatible dump download |

**মূল bits:**
- New migration `0031_dbio.sql` — `admin.db_connections` (encrypted creds via `pgcrypto`), `admin.import_jobs` (status, log, counts)।
- MySQL→Postgres syntax bridge: `AUTO_INCREMENT`→`GENERATED ... IDENTITY`, backticks→double-quotes, `TINYINT(1)`→`boolean`, `ENGINE=…` strip, `DATETIME`→`timestamptz`, `LONGTEXT`→`text`, engine/charset options strip।
- Multipart upload via `@fastify/multipart` (up to 500 MB, streamed to `/tmp`, not memory)।
- `mysql2` + `pg` drivers for live pull; dumped via `pg_dump`/`mysqldump` shell wrappers already available in the container।
- Audit-logged, dangerous-DDL flag required for DROP inside imports।

## 2. Frontend — নতুন Route (`src/routes/dashboard.database-import.tsx`)

Sidebar এ **"Database Import & Connect"** যোগ হবে। Tabs:

1. **Connections** — Add new (dialect picker: PostgreSQL / MySQL / MariaDB / SQLite), Test button (green/red), Save। List of saved connections with quick "Pull schema" / "Pull data" actions।
2. **Import File** — Drag-drop `.sql` / `.sql.gz` / `.csv` / `.json`। Dialect auto-detect + manual override। Target schema selector। "Dry-run (preview statements)" toggle। Progress bar via SSE, live log tail, error rows list।
3. **Import from MySQL** — Pick saved connection → choose tables → map to target schema → Start। Progress + row counts।
4. **Export** — Pick schema/tables → format (Postgres dump / MySQL-compatible dump / CSV zip) → download।
5. **History** — Past import jobs, retry, download log।

সব call `plutoApi()` দিয়ে existing `/admin/v1/*` pattern এ।

## 3. Tests
- `dbio-parser.test.ts` — MySQL→PG syntax converter (15+ cases)।
- Integration: dump a small MySQL fixture, import, assert row counts।

---

## VPS-এ আপনাকে কী করতে হবে

SSH login করে `cd ~/backend-joy/pluto-backend`, তারপর:

```bash
# 1. Latest code pull
git pull

# 2. New migration apply
bash deploy/run-migrator.sh

# 3. mysqldump/mysql client container-এ আছে কিনা নিশ্চিত করো
docker exec $(docker ps --filter name=api -q) which mysqldump || \
  echo "→ Dockerfile-এ mysql-client apt install করা লাগবে (আমি সেটাও আপডেট করবো)"

# 4. API rebuild + restart
docker compose -f docker/docker-compose.yml build api
docker compose -f docker/docker-compose.yml up -d api

# 5. Smoke test
curl -s https://api.timescard.cloud/admin/v1/dbio/connections \
  -H "Authorization: Bearer $SUPERADMIN_TOKEN" | jq
```

Frontend Lovable-এ auto-deploy হবে Publish বাটন চাপলে।

---

## Technical Details (দ্রুত reference)

- **Encrypted creds:** `pgp_sym_encrypt(password, current_setting('app.enc_key'))` — `ENC_KEY` env var লাগবে (আমি `generate_secret` দিয়ে তৈরি করবো)।
- **Streaming import:** statement splitter respects `$$ … $$`, quoted strings, comments; batches of 100 statements per tx।
- **Rollback safety:** whole import wrapped in savepoint per batch; on error → rollback batch, log statement, continue or abort based on user flag।
- **Big files:** files > 50 MB use `COPY … FROM STDIN` for data sections; DDL executed inline।

Approve করলে আমি backend routes + migration + frontend page + tests সব এক ধাপে বানিয়ে দেব, তারপর VPS-এ শুধু উপরের ৫টা কমান্ড চালাতে হবে।
