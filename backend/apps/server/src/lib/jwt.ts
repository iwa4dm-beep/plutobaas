import { SignJWT, jwtVerify } from "jose";
import { env } from "../config.js";

const secret = new TextEncoder().encode(env.JWT_SECRET);

export type AccessClaims = {
  sub: string;
  role: "admin" | "user";
  email: string;
  /** Alias of `sub`, populated by verifyAccessToken for legacy callers. */
  id?: string;
};

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role, email: claims.email })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer("pluto")
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: "pluto" });
  return {
    sub: payload.sub as string,
    id: payload.sub as string,
    role: payload.role as "admin" | "user",
    email: payload.email as string,
  };
}
