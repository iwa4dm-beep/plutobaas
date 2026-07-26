import { request as pwRequest } from "@playwright/test";

/**
 * Playwright global setup: verify the connected Pluto instance's schema
 * version matches what this repo expects. This catches "local vs cloud
 * out of sync" drift before the suite runs (which would otherwise fail
 * with confusing RLS/column errors).
 *
 * Skips when PLUTO_URL / ANON are absent — the suite already skips those
 * tests. Set STARTER_SKIP_SCHEMA_CHECK=1 to force-bypass.
 */
export const EXPECTED_SCHEMA_VERSION = Number(
  process.env.STARTER_EXPECTED_SCHEMA_VERSION ?? 3,
);

export default async function globalSetup() {
  if (process.env.STARTER_SKIP_SCHEMA_CHECK === "1") return;
  const PLUTO_URL = process.env.NEXT_PUBLIC_PLUTO_URL ?? process.env.PLUTO_URL ?? "";
  const ANON = process.env.NEXT_PUBLIC_PLUTO_ANON_KEY ?? process.env.PLUTO_ANON_KEY ?? "";
  if (!PLUTO_URL || !ANON) {
    // eslint-disable-next-line no-console
    console.log("[schema-check] skipped (PLUTO_URL / ANON not set)");
    return;
  }

  const api = await pwRequest.newContext();
  const res = await api.get(
    `${PLUTO_URL}/rest/v1/starter_schema_version?select=version&order=version.desc&limit=1`,
    { headers: { apikey: ANON, authorization: `Bearer ${ANON}` } },
  );

  if (!res.ok()) {
    throw new Error(
      `[schema-check] cannot read starter_schema_version (HTTP ${res.status()}). ` +
        `Apply migrations/*.sql before running e2e — expected v${EXPECTED_SCHEMA_VERSION}.`,
    );
  }
  const rows = (await res.json()) as Array<{ version: number }>;
  const actual = rows?.[0]?.version;
  if (actual !== EXPECTED_SCHEMA_VERSION) {
    throw new Error(
      `[schema-check] schema drift: cloud=v${actual ?? "none"} local=v${EXPECTED_SCHEMA_VERSION}. ` +
        `Run \`psql -f setup.sql\` (or docker-compose starter-schema) against the target DB.`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[schema-check] ok — v${actual}`);
}
