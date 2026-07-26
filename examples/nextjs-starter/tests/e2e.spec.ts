import { test, expect, request as pwRequest } from "@playwright/test";
import crypto from "node:crypto";

const APP = process.env.STARTER_URL ?? "http://localhost:3000";
const PLUTO_URL = process.env.NEXT_PUBLIC_PLUTO_URL ?? process.env.PLUTO_URL ?? "";
const ANON = process.env.NEXT_PUBLIC_PLUTO_ANON_KEY ?? process.env.PLUTO_ANON_KEY ?? "";
const WEBHOOK_SECRET = process.env.PLUTO_WEBHOOK_SECRET ?? "";

const ALICE = {
  email: process.env.E2E_ALICE_EMAIL ?? `alice+${Date.now()}@example.com`,
  password: process.env.E2E_ALICE_PASSWORD ?? "StrongPass!2026",
};
const BOB = {
  email: process.env.E2E_BOB_EMAIL ?? `bob+${Date.now()}@example.com`,
  password: process.env.E2E_BOB_PASSWORD ?? "StrongPass!2026",
};

async function loginDirect(email: string, password: string) {
  const api = await pwRequest.newContext();
  await api.post(`${PLUTO_URL}/auth/v1/signup`, {
    headers: { apikey: ANON, "content-type": "application/json" },
    data: { email, password },
  });
  const res = await api.post(`${PLUTO_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: ANON, "content-type": "application/json" },
    data: { email, password },
  });
  expect(res.ok(), `login ${email} → ${res.status()}`).toBeTruthy();
  return { api, session: await res.json() };
}

function h(session: any) {
  return {
    apikey: ANON,
    authorization: `Bearer ${session.access_token}`,
    "content-type": "application/json",
    prefer: "return=representation",
  };
}

test.describe("Auth + RLS", () => {
  test("user can sign in and insert a note through the UI", async ({ page }) => {
    await page.goto(APP);
    await page.getByTestId("email").fill(ALICE.email);
    await page.getByTestId("password").fill(ALICE.password);
    await page.getByTestId("signup").click().catch(() => {});
    await page.getByTestId("signin").click();
    await expect(page.getByTestId("session")).toContainText("Signed in as", { timeout: 10_000 });

    const body = `ui-note ${Date.now()}`;
    await page.getByTestId("note-body").fill(body);
    await page.getByTestId("add-note").click();
    await expect(page.getByTestId("notes")).toContainText(body, { timeout: 10_000 });
  });

  test("RLS: user B cannot read user A's notes", async () => {
    test.skip(!PLUTO_URL || !ANON, "PLUTO_URL / ANON key not set");

    const alice = await loginDirect(ALICE.email, ALICE.password);
    const bob = await loginDirect(BOB.email, BOB.password);

    const marker = `alice-secret-${crypto.randomUUID()}`;
    const ins = await alice.api.post(`${PLUTO_URL}/rest/v1/notes`, {
      headers: h(alice.session), data: { body: marker },
    });
    expect(ins.ok(), `alice insert → ${ins.status()}`).toBeTruthy();

    const aliceList = await alice.api.get(
      `${PLUTO_URL}/rest/v1/notes?body=eq.${encodeURIComponent(marker)}`,
      { headers: h(alice.session) },
    );
    expect((await aliceList.json()).length).toBeGreaterThan(0);

    const bobList = await bob.api.get(
      `${PLUTO_URL}/rest/v1/notes?body=eq.${encodeURIComponent(marker)}`,
      { headers: h(bob.session) },
    );
    expect(bobList.ok()).toBeTruthy();
    expect(await bobList.json()).toEqual([]);
  });

  test("RLS: Alice can update/delete her rows; Bob cannot", async () => {
    test.skip(!PLUTO_URL || !ANON, "PLUTO_URL / ANON key not set");

    const alice = await loginDirect(ALICE.email, ALICE.password);
    const bob = await loginDirect(BOB.email, BOB.password);

    const marker = `alice-crud-${crypto.randomUUID()}`;
    const ins = await alice.api.post(`${PLUTO_URL}/rest/v1/notes`, {
      headers: h(alice.session), data: { body: marker },
    });
    expect(ins.ok()).toBeTruthy();
    const [row] = await ins.json();
    expect(row?.id).toBeTruthy();

    // Alice UPDATE — succeeds and returns the updated row.
    const patched = `${marker}-patched`;
    const aliceUpd = await alice.api.patch(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(alice.session), data: { body: patched } },
    );
    expect(aliceUpd.ok(), `alice patch → ${aliceUpd.status()}`).toBeTruthy();
    expect((await aliceUpd.json())[0]?.body).toBe(patched);

    // Bob UPDATE — RLS filters the row → 200 with empty array (no rows matched).
    const bobUpd = await bob.api.patch(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(bob.session), data: { body: "hijacked-by-bob" } },
    );
    expect(bobUpd.ok()).toBeTruthy();
    expect(await bobUpd.json()).toEqual([]);

    // Confirm the row is still Alice's patched value.
    const check = await alice.api.get(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(alice.session) },
    );
    expect((await check.json())[0]?.body).toBe(patched);

    // Bob DELETE — no rows affected.
    const bobDel = await bob.api.delete(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(bob.session) },
    );
    expect(bobDel.ok()).toBeTruthy();
    expect(await bobDel.json()).toEqual([]);

    // Row still exists for Alice.
    const stillThere = await alice.api.get(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(alice.session) },
    );
    expect((await stillThere.json()).length).toBe(1);

    // Alice DELETE — succeeds; row disappears.
    const aliceDel = await alice.api.delete(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(alice.session) },
    );
    expect(aliceDel.ok(), `alice delete → ${aliceDel.status()}`).toBeTruthy();

    const gone = await alice.api.get(
      `${PLUTO_URL}/rest/v1/notes?id=eq.${row.id}`,
      { headers: h(alice.session) },
    );
    expect(await gone.json()).toEqual([]);
  });
});

test.describe("Webhooks", () => {
  test("rejects missing signature", async ({ request }) => {
    const res = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "content-type": "application/json" },
      data: JSON.stringify({ type: "test.ping" }),
    });
    expect(res.status()).toBe(401);
  });

  test("rejects tampered signature", async ({ request }) => {
    const res = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": "sha256=deadbeef", "content-type": "application/json" },
      data: JSON.stringify({ type: "test.ping" }),
    });
    expect(res.status()).toBe(401);
  });

  test("accepts a valid HMAC-signed request", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const payload = JSON.stringify({
      type: "notes.inserted",
      id: `evt_${crypto.randomUUID()}`,
      ts: Date.now(),
    });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const res = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" },
      data: payload,
    });
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test("bit-flipped payload fails timing-safe compare", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const payload = JSON.stringify({ type: "notes.inserted", id: "evt_flip" });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const tampered = payload.replace("notes.inserted", "notes.deleted");
    const res = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" },
      data: tampered,
    });
    expect(res.status()).toBe(401);
  });

  test("idempotency: duplicate event id is short-circuited", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const eventId = `evt_${crypto.randomUUID()}`;
    const payload = JSON.stringify({
      type: "notes.inserted",
      id: eventId,
      ts: Date.now(),
      data: { note: "idempotency-check" },
    });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const headers = { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" };

    const first = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false });

    // Replay the exact same signed payload — must be recognized as duplicate.
    const second = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(second.status()).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true });

    // A different event id with a valid signature is processed as new.
    const freshPayload = JSON.stringify({
      type: "notes.inserted",
      id: `evt_${crypto.randomUUID()}`,
      ts: Date.now(),
    });
    const freshSig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(freshPayload).digest("hex");
    const third = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${freshSig}`, "content-type": "application/json" },
      data: freshPayload,
    });
    expect(third.status()).toBe(200);
    expect(await third.json()).toMatchObject({ ok: true, duplicate: false });
  });

  test("durable idempotency: duplicate rejected even after simulated restart", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const eventId = `evt_durable_${crypto.randomUUID()}`;
    const payload = JSON.stringify({ type: "notes.inserted", id: eventId, ts: Date.now() });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const headers = { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" };

    // First delivery — fresh.
    const first = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false });

    // Clear the in-memory hot cache to simulate a process restart. The
    // durable store (file or Redis) is untouched, so the very next replay
    // must still be flagged as a duplicate — proving persistence.
    const reset = await request.post(`${APP}/api/webhooks/pluto/_simulate_restart`);
    expect(reset.status(), "restart-sim endpoint must be enabled in CI").toBe(200);
    const resetBody = await reset.json();
    expect(resetBody.after.hotCacheSize).toBe(0);

    const replay = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(replay.status()).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, duplicate: true });
  });

  test("idempotency: same event.id with a DIFFERENT payload is still a duplicate", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const eventId = `evt_repayload_${crypto.randomUUID()}`;

    // First delivery: one payload shape.
    const payloadA = JSON.stringify({
      type: "notes.inserted",
      id: eventId,
      ts: Date.now(),
      data: { note: "first-shape", version: 1 },
    });
    const sigA = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payloadA).digest("hex");
    const first = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${sigA}`, "content-type": "application/json" },
      data: payloadA,
    });
    expect(first.status()).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false });

    // Second delivery: SAME event.id, but a completely different payload.
    // Each request is validly signed against its own body, so signature
    // verification passes — dedupe MUST kick in strictly on event.id and
    // suppress any additional side effects.
    const payloadB = JSON.stringify({
      type: "notes.updated",                 // different type
      id: eventId,                           // same id
      ts: Date.now() + 42,
      data: { note: "second-shape", version: 2, extra: true },
    });
    const sigB = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payloadB).digest("hex");
    const second = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${sigB}`, "content-type": "application/json" },
      data: payloadB,
    });
    expect(second.status()).toBe(200);
    expect(await second.json()).toMatchObject({ ok: true, duplicate: true });
  });

  test("idempotency TTL: after PLUTO_WEBHOOK_IDEMPOTENCY_TTL_MS elapses, replays are fresh", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    // CI/dev set a small TTL (e.g. 2000ms). If the deployed server uses the
    // default 24h TTL we cannot verify expiry in a reasonable time — skip.
    const ttlHint = Number(process.env.PLUTO_WEBHOOK_IDEMPOTENCY_TTL_MS ?? "0");
    test.skip(!ttlHint || ttlHint > 10_000, "TTL not configured for fast expiry (set PLUTO_WEBHOOK_IDEMPOTENCY_TTL_MS ≤ 10000)");

    const eventId = `evt_ttl_${crypto.randomUUID()}`;
    const payload = JSON.stringify({ type: "notes.inserted", id: eventId, ts: Date.now() });
    const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const headers = { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" };

    const first = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(await first.json()).toMatchObject({ duplicate: false });
    const dup = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(await dup.json()).toMatchObject({ duplicate: true });

    // Wait past TTL (+ small buffer for the file sweep to kick in on the next put).
    await new Promise((r) => setTimeout(r, ttlHint + 500));

    const afterTtl = await request.post(`${APP}/api/webhooks/pluto`, { headers, data: payload });
    expect(afterTtl.status()).toBe(200);
    expect(await afterTtl.json()).toMatchObject({ duplicate: false });
  });


  test("invalid HMAC produces no side effects (event id not marked seen)", async ({ request }) => {
    test.skip(!WEBHOOK_SECRET, "PLUTO_WEBHOOK_SECRET not set");
    const eventId = `evt_forgery_${crypto.randomUUID()}`;
    const payload = JSON.stringify({ type: "notes.inserted", id: eventId, ts: Date.now() });

    // Forgery attempts must all be rejected with 401 and MUST NOT touch state.
    const forgeries: Array<Record<string, string>> = [
      { "x-pluto-signature": "sha256=deadbeef" },
      { "x-pluto-signature": `sha256=${"0".repeat(64)}` },
      {
        "x-pluto-signature": `sha256=${crypto
          .createHmac("sha256", `${WEBHOOK_SECRET}-wrong`)
          .update(payload)
          .digest("hex")}`,
      },
      {}, // no signature at all
    ];
    for (const extra of forgeries) {
      const res = await request.post(`${APP}/api/webhooks/pluto`, {
        headers: { "content-type": "application/json", ...extra },
        data: payload,
      });
      expect([401, 403]).toContain(res.status());
    }

    // Now deliver the SAME event id with a valid signature. If the invalid
    // deliveries above had accidentally marked the id as seen, this would
    // come back as `duplicate: true`. It must be treated as fresh.
    const goodSig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
    const good = await request.post(`${APP}/api/webhooks/pluto`, {
      headers: { "x-pluto-signature": `sha256=${goodSig}`, "content-type": "application/json" },
      data: payload,
    });
    expect(good.status()).toBe(200);
    expect(await good.json()).toMatchObject({ ok: true, duplicate: false });
  });
});
