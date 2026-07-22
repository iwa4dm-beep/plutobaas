/**
 * Pluto BaaS client — copy into `src/lib/pluto.ts` in your Lovable frontend.
 *
 * Requires:
 *   bun add @timescard/pluto-js
 *
 * .env:
 *   VITE_PLUTO_URL=https://api.timescard.cloud
 *   VITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxxxxxx
 */
import { createClient } from "@timescard/pluto-js";

const url = import.meta.env.VITE_PLUTO_URL as string;
const anonKey = import.meta.env.VITE_PLUTO_ANON_KEY as string;

if (!url || !anonKey) {
  throw new Error(
    "Missing VITE_PLUTO_URL / VITE_PLUTO_ANON_KEY — set them in .env",
  );
}

export const pluto = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    storageKey: "pluto.auth.token",
  },
});
