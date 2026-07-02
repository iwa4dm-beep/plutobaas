# `pluto` CLI

Single-binary CLI for driving a Pluto BaaS instance from your laptop or CI.

```
$ pluto --help
Usage: pluto [options] [command]

Commands:
  init                  Scaffold a pluto.config.json in the current dir
  login                 Device-flow login against a Pluto instance
  whoami                Print the current session
  migrations <sub>      new | status | apply | rollback | dry-run
  sql [file]            Run a .sql file (or read stdin) against the workspace
  workspaces <sub>      list | create | keys
  functions <sub>       list | deploy | remove | invoke
  secrets <sub>         set | list | delete
```

Config file (auto-created by `pluto init`) — checked into repo:

```json
{
  "url": "http://localhost:8080",
  "workspace": "acme",
  "anonKey": "pk_anon_...",
  "migrationsDir": "./backend/apps/server/src/db/migrations"
}
```

Credentials (**never** committed) live in `~/.pluto/config.json` with mode
`0600` — one entry per Pluto instance URL.

## Roadmap

Phase 14.0 (current): package skeleton, `--version`, `--help`, `init`,
`whoami` stubs.

Phase 14.4 will land the full command surface described in
[`docs/PHASE-14.md`](../../../docs/PHASE-14.md).
