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
});
