import type { FastifyRequest } from 'fastify';
import { getSql } from '../db/pool.js';
import type { Config } from '../config.js';

export type Actor = {
  userId: string;
  role: 'authenticated' | 'service_role';
  isSuperadmin: boolean;
};

export async function requireAuth(req: FastifyRequest, cfg: Config): Promise<Actor> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) {
    const e: any = new Error('Unauthorized'); e.statusCode = 401; throw e;
  }
  const decoded: any = await (req as any).jwtVerify();
  const userId = decoded?.sub;
  if (!userId) { const e: any = new Error('Invalid token'); e.statusCode = 401; throw e; }
  const sql = getSql(cfg);
  const [u] = await sql<any[]>`select is_superadmin from auth.users where id = ${userId}`;
  return {
    userId,
    role: decoded?.role === 'service_role' ? 'service_role' : 'authenticated',
    isSuperadmin: !!u?.is_superadmin,
  };
}

export async function requireProjectRole(
  cfg: Config, projectId: string, actor: Actor, roles: string[],
): Promise<void> {
  if (actor.isSuperadmin || actor.role === 'service_role') return;
  const sql = getSql(cfg);
  const [row] = await sql<any[]>`
    select role from admin.project_members
    where project_id = ${projectId} and user_id = ${actor.userId}`;
  if (!row || !roles.includes(row.role)) {
    const e: any = new Error('Forbidden'); e.statusCode = 403; throw e;
  }
}
