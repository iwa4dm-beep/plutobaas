import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config.js";
import { verifyAccessToken, type AccessClaims } from "./jwt.js";

export type ApiKeyKind = "anon" | "service_role";

export type RequestAuth = {
  apiKey: ApiKeyKind;
  user: AccessClaims | null;
};

declare module "fastify" {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const key = req.headers["apikey"] ?? req.headers["x-api-key"];
  const value = Array.isArray(key) ? key[0] : key;
  let kind: ApiKeyKind | null = null;
  if (value === env.ANON_KEY) kind = "anon";
  else if (value === env.SERVICE_ROLE_KEY) kind = "service_role";
  if (!kind) {
    reply.code(401).send({ error: "invalid_api_key" });
    return;
  }

  let user: AccessClaims | null = null;
  const authz = req.headers.authorization;
  if (authz?.startsWith("Bearer ")) {
    const token = authz.slice(7);
    try {
      user = await verifyAccessToken(token);
    } catch {
      reply.code(401).send({ error: "invalid_token" });
      return;
    }
  }
  req.auth = { apiKey: kind, user };
}

export function requireServiceRole(req: FastifyRequest, reply: FastifyReply): void {
  if (req.auth?.apiKey !== "service_role") {
    reply.code(403).send({ error: "service_role_required" });
  }
}
