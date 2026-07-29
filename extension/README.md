# Pluto Migrator (Chrome extension)

One-click migration of a project from **Lovable**, **GitHub** and **Supabase**
into **Pluto BaaS**, using the sessions you are already signed into. Nothing
but the collected descriptor leaves your browser — no passwords, no tokens.

## Install (unpacked)

1. Download and unzip `pluto-migrator-extension.zip`.
2. Open `chrome://extensions`.
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the unzipped folder.

## Configure

Open the extension popup and fill in:

- **Ingest endpoint** — `https://<your-pluto-dashboard>/api/public/pluto-import`
- **Shared secret** — the value of `PLUTO_IMPORT_WEBHOOK_SECRET` from your
  Pluto project secrets.

## Use

| Tab you are on | What is collected |
| --- | --- |
| Lovable project | project id, name, linked GitHub repo |
| GitHub repo | repo URL, branch, zipball URL |
| Supabase SQL editor | the SQL currently in the editor (paste your schema dump there) |

Click **Collect this tab** → review the JSON → **Send to Pluto**.

The payload is signed `HMAC-SHA256(secret, "<unix-ts>.<body>")` and sent as
`x-pluto-signature: sha256=<hex>` with `x-pluto-timestamp`. The server rejects
signatures older than 5 minutes, and `event_id` is unique so replays are no-ops.

## Then, in the Pluto dashboard

Go to **Marketplace & Extensions → Pluto Migrator**. Each import shows up as a
job where you can **Re-translate**, **Dry-run** (rolled-back transaction) and
**Apply** the converted migration, or hand the repo to Auto-Deploy Studio.
