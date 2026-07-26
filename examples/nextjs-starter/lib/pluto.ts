/**
 * Minimal Pluto BaaS fetch client — no external deps.
 * Works in the browser (anon key) and on the server (service_role).
 */

export type PlutoSession = {
  access_token: string;
  refresh_token: string;
  user: { id: string; email: string };
};

const URL = process.env.NEXT_PUBLIC_PLUTO_URL!;
const ANON = process.env.NEXT_PUBLIC_PLUTO_ANON_KEY!;

function assertEnv() {
  if (!URL || !ANON) {
    throw new Error(
      "Pluto env missing: set NEXT_PUBLIC_PLUTO_URL and NEXT_PUBLIC_PLUTO_ANON_KEY in .env.local",
    );
  }
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = body?.message || body?.error || res.statusText;
    throw new Error(`Pluto ${res.status}: ${msg}`);
  }
  return body as T;
}

export async function signUp(email: string, password: string) {
  assertEnv();
  return json<PlutoSession>(
    await fetch(`${URL}/auth/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ANON },
      body: JSON.stringify({ email, password }),
    }),
  );
}

export async function signIn(email: string, password: string) {
  assertEnv();
  return json<PlutoSession>(
    await fetch(`${URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: ANON },
      body: JSON.stringify({ email, password }),
    }),
  );
}

export function authed(session: PlutoSession | null) {
  return {
    async from<T = unknown>(table: string) {
      const base = `${URL}/rest/v1/${table}`;
      const headers = {
        apikey: ANON,
        authorization: session ? `Bearer ${session.access_token}` : `Bearer ${ANON}`,
        "content-type": "application/json",
        prefer: "return=representation",
      };
      return {
        list: () => fetch(base, { headers }).then((r) => json<T[]>(r)),
        insert: (row: Partial<T>) =>
          fetch(base, { method: "POST", headers, body: JSON.stringify(row) }).then((r) =>
            json<T[]>(r),
          ),
        update: (filter: string, patch: Partial<T>) =>
          fetch(`${base}?${filter}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify(patch),
          }).then((r) => json<T[]>(r)),
        remove: (filter: string) =>
          fetch(`${base}?${filter}`, { method: "DELETE", headers }).then((r) => json<T[]>(r)),
      };
    },
  };
}
