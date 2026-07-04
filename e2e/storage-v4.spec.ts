// Phase 54 — Playwright e2e for Storage v4.
// Runs against the local API only when PLUTO_ENABLE_STORAGE_V4=1. Skips
// otherwise so CI doesn't hit disabled endpoints.
import { test, expect } from "@playwright/test";

const BASE = process.env.PLUTO_API_BASE ?? "http://localhost:8080";
const API_KEY = process.env.PLUTO_API_KEY ?? "dev-anon";

const enabled = process.env.PLUTO_ENABLE_STORAGE_V4 === "1";

test.describe("storage v4 e2e", () => {
  test.skip(!enabled, "PLUTO_ENABLE_STORAGE_V4 must be 1");

  const bucket = "e2e-bucket";
  const key = `obj-${Date.now()}.txt`;
  let v1 = ""; let v2 = "";

  test("uploads multiple versions and lists newest first", async ({ request }) => {
    const up1 = await request.post(`${BASE}/storage/v4/objects`, {
      headers: { apikey: API_KEY },
      data: { bucket, object_key: key, body_base64: Buffer.from("first").toString("base64") },
    });
    expect(up1.ok()).toBeTruthy();
    v1 = (await up1.json()).version.version_id;

    const up2 = await request.post(`${BASE}/storage/v4/objects`, {
      headers: { apikey: API_KEY },
      data: { bucket, object_key: key, body_base64: Buffer.from("second").toString("base64") },
    });
    v2 = (await up2.json()).version.version_id;

    const list = await request.get(`${BASE}/storage/v4/objects/${bucket}/${encodeURIComponent(key)}/versions`,
      { headers: { apikey: API_KEY } });
    const body = await list.json();
    expect(body.versions[0].version_id).toBe(v2);
    expect(body.versions).toHaveLength(2);
  });

  test("compliance retention blocks deletion until expiry", async ({ request }) => {
    const until = new Date(Date.now() + 60_000).toISOString();
    const r = await request.post(`${BASE}/storage/v4/retention`, {
      headers: { apikey: API_KEY },
      data: { bucket, object_key: key, version_id: v1, mode: "compliance", retain_until: until },
    });
    expect(r.ok()).toBeTruthy();

    const del = await request.delete(
      `${BASE}/storage/v4/objects/${bucket}/${encodeURIComponent(key)}/versions/${v1}`,
      { headers: { apikey: API_KEY, "x-retention-bypass": "governance" } },
    );
    expect(del.status()).toBe(409); // compliance ignores bypass
  });

  test("cross-region replication succeeds with checksum verification", async ({ request }) => {
    const sub = await request.post(`${BASE}/storage/v4/replication/submit`, {
      headers: { apikey: API_KEY },
      data: { bucket, object_key: key, version_id: v2,
        source_region: "us-east", target_region: "eu-west",
        idempotency_key: `e2e-${v2}` },
    });
    const jobId = (await sub.json()).job.id;
    const run = await request.post(`${BASE}/storage/v4/replication/run`, {
      headers: { apikey: API_KEY }, data: { job_id: jobId },
    });
    const done = (await run.json()).job;
    expect(done.status).toBe("succeeded");
    expect(done.checksum_verified).toBe(true);

    const status = await request.get(
      `${BASE}/storage/v4/replication/status?bucket=${bucket}&object_key=${encodeURIComponent(key)}&version_id=${v2}`,
      { headers: { apikey: API_KEY } });
    const s = await status.json();
    expect(s.jobs.some((j: { status: string }) => j.status === "succeeded")).toBe(true);
  });
});
