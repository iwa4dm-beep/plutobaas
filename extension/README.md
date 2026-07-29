# Pluto Migrator — Chrome Extension (v2)

Collects your Lovable project, GitHub repo and Supabase schema from the tabs you
are already logged into, then ships a single **HMAC-signed** migration job to
Pluto BaaS (`/api/public/pluto-import`). No credentials ever leave the browser —
only the signature is transmitted.

## What's new in v2

1. **Multi-tab scan & merge** — one click reads every open Lovable / GitHub /
   Supabase tab and merges them into a single job (largest SQL dump wins).
2. **Preflight checklist** — shows exactly what is present or missing (repo,
   zipball URL, schema SQL, Supabase ref, table inventory) before you send.
3. **Secret scanner + auto-redaction** — service_role JWTs, `sb_secret_`,
   GitHub/OpenAI/AWS keys, Postgres URLs with passwords and PEM keys are
   detected and replaced with `[REDACTED:…]` (toggleable).
4. **Retry queue** — network errors, 429s and 5xx are queued and retried with
   exponential backoff via `chrome.alarms`, with a badge counter.
5. **Job history** — last 50 jobs with status, sources, SQL size, redaction
   count, job id and error, plus a manual "retry queue now".
6. **Connection self-test** — signs a probe payload and reports latency and
   whether the shared secret was accepted.
7. **Multiple profiles** — keep prod / staging / local endpoint+secret pairs and
   switch between them.
8. **Quick capture** — `Alt+Shift+P` or the right-click menu scans all tabs and
   sends in one shot, with a desktop notification on completion.
9. **Deeper collection** — Monaco *and* CodeMirror SQL editors, Supabase table
   inventory, repo branch/private flag, Lovable published URL.

## Install

1. Download `pluto-migrator-extension.zip` from the Pluto Marketplace page and unzip it.
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select the unzipped folder.
4. Open the popup → **Settings** → set the ingest endpoint and the
   `PLUTO_IMPORT_WEBHOOK_SECRET` value → **Save profile** → **Test connection**.

## Usage

1. Open the tabs: Lovable project, GitHub repo, Supabase SQL editor (with your
   schema dump visible).
2. Popup → **Scan all tabs** → review the preflight list and secret scan.
3. **Send to Pluto** — track the job in the dashboard at
   `/dashboard/pluto-marketplace` and `/dashboard/import-audit`.
