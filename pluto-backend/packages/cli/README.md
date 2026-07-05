# @pluto/cli

Zero-dependency CLI for the Pluto BaaS backend.

## Install

```bash
npm install -g ./pluto-backend/packages/cli
# or run directly:
node pluto-backend/packages/cli/bin/pluto.mjs help
```

## Common flows

```bash
pluto login https://api.example.com --email me@x.com --password '***'
pluto projects list
pluto link --project 00000000-0000-0000-0000-000000000000
pluto db push migrations/
pluto gen sdk --out ./src/pluto.ts
pluto functions deploy hello ./functions/hello.js
pluto backups create
pluto webhooks list
```

Global config lives at `~/.pluto/config.json`. Per-project link lives at
`./.pluto.json` (add to `.gitignore` if you don't want to commit it).
