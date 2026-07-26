import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

const EMAIL =
  process.env.E2E_TEST_EMAIL ?? `e2e+${Date.now()}@example.com`;
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "StrongPass!2026";
const APP = process.env.STARTER_URL ?? "http://localhost:3000";
const WEBHOOK_SECRET = process.env.PLUTO_WEBHOOK_SECRET ?? "";

test("auth + RLS notes round-trip", async ({ page }) => {
  await page.goto(APP);
  await page.getByTestId("email").fill(EMAIL);
  await page.getByTestId("password").fill(PASSWORD);
  // sign up is idempotent-ish; ignore if user exists then sign in
  await page.getByTestId("signup").click().catch(() => {});
  await page.getByTestId("signin").click();
  await expect(page.getByTestId("session")).toContainText("Signed in as", { timeout: 10_000 });

  const body = `hello ${Date.now()}`;
  await page.getByTestId("note-body").fill(body);
  await page.getByTestId("add-note").click();
  await expect(page.getByTestId("notes")).toContainText(body, { timeout: 10_000 });
});

test("webhook rejects bad signature, accepts good one", async ({ request }) => {
  const payload = JSON.stringify({ type: "test.ping", id: "evt_1" });

  const bad = await request.post(`${APP}/api/webhooks/pluto`, {
    headers: { "x-pluto-signature": "sha256=deadbeef", "content-type": "application/json" },
    data: payload,
  });
  expect(bad.status()).toBe(401);

  if (!WEBHOOK_SECRET) test.skip(true, "PLUTO_WEBHOOK_SECRET not set");
  const sig = crypto.createHmac("sha256", WEBHOOK_SECRET).update(payload).digest("hex");
  const good = await request.post(`${APP}/api/webhooks/pluto`, {
    headers: { "x-pluto-signature": `sha256=${sig}`, "content-type": "application/json" },
    data: payload,
  });
  expect(good.status()).toBe(200);
});
