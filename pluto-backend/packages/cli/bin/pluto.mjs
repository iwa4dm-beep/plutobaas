#!/usr/bin/env node
// Pluto CLI — minimal, dependency-free
// Commands: login, link, whoami, db push, db pull, gen sdk, functions deploy, projects list
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename } from 'node:path';

const CFG_DIR  = join(homedir(), '.pluto');
const CFG_PATH = join(CFG_DIR, 'config.json');
const LOCAL    = join(process.cwd(), '.pluto.json');

async function loadCfg() {
  try { return JSON.parse(await readFile(CFG_PATH, 'utf8')); } catch { return {}; }
}
async function saveCfg(o) {
  await mkdir(CFG_DIR, { recursive: true });
  await writeFile(CFG_PATH, JSON.stringify(o, null, 2));
}
async function loadLocal() {
  try { return JSON.parse(await readFile(LOCAL, 'utf8')); } catch { return {}; }
}
async function saveLocal(o) { await writeFile(LOCAL, JSON.stringify(o, null, 2)); }

async function api(path, init = {}) {
  const cfg = await loadCfg();
  if (!cfg.url) throw new Error('Not logged in. Run: pluto login <url>');
  const res = await fetch(cfg.url.replace(/\/+$/, '') + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) throw new Error((data && data.message) || text || res.statusText);
  return data;
}

const [, , cmd, sub, ...rest] = process.argv;

const commands = {
  async help() {
    console.log(`Pluto CLI
Usage:
  pluto login <url> [--email you@x --password ...]   # save credentials
  pluto whoami                                       # show current user
  pluto link --project <uuid>                        # link cwd to project
  pluto projects list
  pluto db push [migrations/]                        # apply .sql files as migrations
  pluto db pull                                      # dump schema.sql
  pluto gen sdk [--out ./pluto.ts]                   # generate typed SDK
  pluto functions deploy <name> <file.js>            # deploy edge function
  pluto backups create                               # create a backup
  pluto webhooks list`);
  },

  async login() {
    const url = sub;
    if (!url) throw new Error('usage: pluto login <url> [--email --password]');
    const args = Object.fromEntries(rest.reduce((a, v, i, arr) => {
      if (v.startsWith('--')) a.push([v.slice(2), arr[i + 1]]); return a;
    }, []));
    const cfg = { url };
    if (args.email && args.password) {
      const res = await fetch(url.replace(/\/+$/, '') + '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: args.email, password: args.password }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      cfg.token = j.access_token;
      cfg.email = args.email;
    }
    await saveCfg(cfg);
    console.log(`✓ Logged in to ${url}${cfg.email ? ` as ${cfg.email}` : ' (unauthenticated — token not stored)'}`);
  },

  async whoami() {
    const cfg = await loadCfg();
    console.log(JSON.stringify({ url: cfg.url, email: cfg.email ?? null }, null, 2));
  },

  async link() {
    const idx = process.argv.indexOf('--project');
    const project = idx > 0 ? process.argv[idx + 1] : null;
    if (!project) throw new Error('usage: pluto link --project <uuid>');
    await saveLocal({ project });
    console.log(`✓ Linked to project ${project}`);
  },

  async projects() {
    if (sub !== 'list') return this.help();
    const rows = await api('/admin/v1/projects');
    for (const r of rows) console.log(`${r.id}  ${r.name}`);
  },

  async db() {
    const local = await loadLocal();
    if (!local.project) throw new Error('Run: pluto link --project <uuid> first.');
    if (sub === 'push') {
      const dir = rest[0] || 'migrations';
      const files = (await (await import('node:fs/promises')).readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
      for (const f of files) {
        const sql = await readFile(join(dir, f), 'utf8');
        process.stdout.write(`applying ${f}... `);
        await api('/admin/v1/sql/exec', {
          method: 'POST',
          body: JSON.stringify({ project_id: local.project, sql, confirm_destructive: true }),
        });
        console.log('ok');
      }
    } else if (sub === 'pull') {
      const res = await api(`/admin/v1/sdk/generate?project_id=${local.project}`);
      await writeFile('schema.sql', typeof res === 'string' ? res : JSON.stringify(res));
      console.log('wrote schema.sql');
    } else this.help();
  },

  async gen() {
    if (sub !== 'sdk') return this.help();
    const local = await loadLocal();
    if (!local.project) throw new Error('Run: pluto link --project <uuid> first.');
    const out = (() => {
      const i = rest.indexOf('--out');
      return i > -1 ? rest[i + 1] : './pluto-sdk.ts';
    })();
    const cfg = await loadCfg();
    const res = await fetch(`${cfg.url}/admin/v1/sdk/generate?project_id=${local.project}`, {
      headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    });
    if (!res.ok) throw new Error(await res.text());
    await writeFile(out, await res.text());
    console.log(`✓ Wrote ${out}`);
  },

  async functions() {
    if (sub !== 'deploy') return this.help();
    const [name, file] = rest;
    if (!name || !file) throw new Error('usage: pluto functions deploy <name> <file.js>');
    const local = await loadLocal();
    const code = await readFile(resolve(file), 'utf8');
    const res = await api('/admin/v1/functions', {
      method: 'POST',
      body: JSON.stringify({ project_id: local.project, name, slug: name, code, verify_jwt: true }),
    });
    console.log(`✓ Deployed ${name} (id=${res.id})`);
  },

  async backups() {
    const local = await loadLocal();
    if (sub !== 'create') return this.help();
    const res = await api('/admin/v1/backups', {
      method: 'POST', body: JSON.stringify({ project_id: local.project, kind: 'full' }),
    });
    console.log(`✓ Backup requested: ${res.id}`);
  },

  async webhooks() {
    const local = await loadLocal();
    if (sub !== 'list') return this.help();
    const rows = await api(`/admin/v1/webhooks?project_id=${local.project}`);
    for (const w of rows) console.log(`${w.id}  ${w.name}  → ${w.target_url}`);
  },
};

(async () => {
  try {
    const fn = commands[cmd] ?? commands.help;
    await fn.call(commands);
  } catch (e) {
    console.error(`✗ ${e.message ?? e}`);
    process.exit(1);
  }
})();
