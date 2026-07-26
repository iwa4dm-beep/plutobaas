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

/** Low-level helper — sign up (ignoring "already exists") then sign in via Pluto Auth API. */
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
  const session = await res.json();
  return { api, session };
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
    test.skip(!PLUTO_URL || !ANON, "PLUTO_URL / ANON key not set — RLS scope test skipped");

    const alice = await loginDirect(ALICE.email, ALICE.password);
    const bob = await loginDirect(BOB.email, BOB.password);

    const marker = `alice-secret-${crypto.randomUUID()}`;
    const ins = await alice.api.post(`${PLUTO_URL}/rest/v1/notes`, {
      headers: {
        apikey: ANON,
        authorization: `Bearer ${alice.session.access_token}`,
        "content-type": "application/json",
        prefer: "return=representation",
      },
      data: { body: marker },
    });
    expect(ins.ok(), `alice insert → ${ins.status()}`).toBeTruthy();

    // Alice sees her own row.
    const aliceList = await alice.api.get(`${PLUTO_URL}/rest/v1/notes?body=eq.${encodeURIComponent(marker)}`, {
      headers: { apikey: ANON, authorization: `Bearer ${alice.session.access_token}` },
    });
    expect((await aliceList.json()).length).toBeGreaterThan(0);

    // Bob must NOT see it — RLS filters it out.
    const bobList = await bob.api.get(`${PLUTO_URL}/rest/v1/notes?body=eq.${encodeURIComponent(marker)}`, {
      headers: { apikey: ANON, authorization: `Bearer ${bob.session.access_token}` },
    });
    expect(bobList.ok()).toBeTruthy();
    expect(await bobList.json()).toEqual([]);
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
      headers: {
        "x-pluto-signature": `sha256=${sig}`,
        "content-type": "application/json",
      },
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
