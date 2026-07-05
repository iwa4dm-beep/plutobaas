import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';
import { requireAuth, requireProjectRole } from '../util/auth.js';

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;
const pgToTs = (t: string): string => {
  if (['int2', 'int4', 'int8', 'float4', 'float8', 'numeric'].includes(t)) return 'number';
  if (t === 'bool') return 'boolean';
  if (t === 'jsonb' || t === 'json') return 'Record<string, unknown>';
  if (t === 'uuid' || t.startsWith('text') || t.startsWith('varchar') || t === 'bpchar') return 'string';
  if (t === 'timestamptz' || t === 'timestamp' || t === 'date') return 'string';
  return 'string';
};

async function generateSdk(sql: any, schemas: string[], apiUrl: string, projectId: string): Promise<string> {
  const cols = await sql`
    select c.table_schema, c.table_name, c.column_name, c.udt_name, c.is_nullable = 'YES' as nullable
      from information_schema.columns c
     where c.table_schema = any(${schemas})
     order by c.table_schema, c.table_name, c.ordinal_position`;

  const tables = new Map<string, Array<{ n: string; t: string; nullable: boolean }>>();
  for (const c of cols) {
    const key = `${c.table_schema}.${c.table_name}`;
    if (!IDENT.test(c.table_name) || !IDENT.test(c.column_name)) continue;
    if (!tables.has(key)) tables.set(key, []);
    tables.get(key)!.push({ n: c.column_name, t: c.udt_name, nullable: c.nullable });
  }

  const types: string[] = [];
  const dbTypeEntries: string[] = [];
  for (const [key, list] of tables) {
    const [, name] = key.split('.');
    const iface = name.split('_').map((p) => p[0].toUpperCase() + p.slice(1)).join('');
    types.push(
      `export interface ${iface} {\n` +
        list.map((c) => `  ${c.n}: ${pgToTs(c.t)}${c.nullable ? ' | null' : ''};`).join('\n') +
        `\n}`,
    );
    dbTypeEntries.push(`  ${name}: ${iface};`);
  }

  return `/**
 * Auto-generated Pluto SDK
 * Project: ${projectId}
 * Generated at ${new Date().toISOString()}
 */

${types.join('\n\n')}

export interface Database {
${dbTypeEntries.join('\n')}
}

type TableName = keyof Database;

export class PlutoClient {
  constructor(private opts: { url?: string; apiKey?: string; token?: string } = {}) {
    this.opts.url = opts.url ?? '${apiUrl}';
  }

  private async req(path: string, init: RequestInit = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.opts.apiKey ? { apikey: this.opts.apiKey } : {}),
      ...(this.opts.token ? { Authorization: \`Bearer \${this.opts.token}\` } : {}),
      ...((init.headers as Record<string, string>) || {}),
    };
    const res = await fetch(\`\${this.opts.url}\${path}\`, { ...init, headers });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(data?.message || res.statusText);
    return data;
  }

  from<T extends TableName>(table: T) {
    const self = this;
    return {
      select: async (query = '*'): Promise<Database[T][]> =>
        self.req(\`/rest/v1/\${table}?select=\${encodeURIComponent(query)}\`),
      insert: async (row: Partial<Database[T]> | Partial<Database[T]>[]): Promise<Database[T][]> =>
        self.req(\`/rest/v1/\${table}\`, { method: 'POST', body: JSON.stringify(row) }),
      update: async (patch: Partial<Database[T]>, match: Partial<Database[T]>): Promise<Database[T][]> => {
        const q = Object.entries(match).map(([k, v]) => \`\${k}=eq.\${v}\`).join('&');
        return self.req(\`/rest/v1/\${table}?\${q}\`, { method: 'PATCH', body: JSON.stringify(patch) });
      },
      delete: async (match: Partial<Database[T]>): Promise<Database[T][]> => {
        const q = Object.entries(match).map(([k, v]) => \`\${k}=eq.\${v}\`).join('&');
        return self.req(\`/rest/v1/\${table}?\${q}\`, { method: 'DELETE' });
      },
    };
  }

  auth = {
    signIn: (email: string, password: string) =>
      this.req('/auth/v1/token?grant_type=password', {
        method: 'POST', body: JSON.stringify({ email, password }),
      }),
    signUp: (email: string, password: string) =>
      this.req('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  };
}

export const createClient = (opts?: { url?: string; apiKey?: string; token?: string }) =>
  new PlutoClient(opts);
`;
}

export async function sdkRoutes(app: FastifyInstance, cfg: Config) {
  app.get('/admin/v1/sdk/generate', async (req, reply) => {
    const actor = await requireAuth(req, cfg);
    const q = z.object({
      project_id: z.string().uuid(),
      schemas: z.string().optional(),   // csv
    }).parse(req.query);
    await requireProjectRole(cfg, q.project_id, actor, ['owner', 'admin', 'member']);
    const sql = getSql(cfg);
    const schemas = q.schemas ? q.schemas.split(',') : ['public'];
    const apiUrl = cfg.PUBLIC_API_URL ?? `http://${cfg.HOST}:${cfg.PORT}`;
    const sdk = await generateSdk(sql, schemas, apiUrl, q.project_id);
    await sql`
      insert into admin.sdk_generations (project_id, language, version, size_bytes, requested_by)
      values (${q.project_id}, 'typescript', ${new Date().toISOString()}, ${sdk.length}, ${actor.userId})`;
    reply.header('Content-Type', 'application/typescript');
    reply.header('Content-Disposition', `attachment; filename="pluto-sdk-${q.project_id.slice(0, 8)}.ts"`);
    return sdk;
  });
}
