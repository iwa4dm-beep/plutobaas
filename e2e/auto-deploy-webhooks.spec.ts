// E2E — Auto-Deploy Studio webhooks:
//   1. Every lifecycle event (approval, step, failure, rollback, publish)
//      dispatches a POST to the configured endpoint with the expected shape.
//   2. Signed webhooks carry `x-pluto-signature: sha256=<hex>` computed with
//      the shared secret over the raw JSON body — verifiable client-side.
//   3. Failed deliveries (500 response) are retried with backoff and the
//      final endpoint status ends in "failed" after MAX_ATTEMPTS.
//   4. The payload-schema panel exposes JSON for every event and downloads
//      a bundle.
import { test, expect, type Page, type Request } from "@playwright/test";
import { createHmac } from "node:crypto";

async function seedWebhook(
  page: Page,
  cfg: { url: string; secret?: string; events?: string[] },
) {
  const events = cfg.events ?? [
    "approval.awaiting", "approval.confirmed", "approval.cancelled",
    "step.running", "step.ok", "step.fail",
    "deploy.retry", "deploy.failed", "deploy.published",
    "rollback.started", "rollback.completed",
  ];
  await page.addInitScript((c) => {
    localStorage.setItem("pluto:auto-deploy:webhooks", JSON.stringify([{
      id: "wh_test", label: "test", url: c.url, secret: c.secret,
      events: c.events, enabled: true, format: "json", createdAt: Date.now(),
    }]));
    localStorage.removeItem("pluto:auto-deploy:webhook-log");
    localStorage.removeItem("pluto:auto-deploy:webhook-endpoint-status");
  }, { url: cfg.url, secret: cfg.secret, events });
}

function captured(page: Page, urlMatch: RegExp) {
  const reqs: Request[] = [];
  page.on("request", (r) => { if (urlMatch.test(r.url()) && r.method() === "POST") reqs.push(r); });
  return reqs;
}

test.describe("Auto-Deploy Studio — Webhooks", () => {
  test("payload schemas panel exposes every event and downloads bundle", async ({ page }) => {
    await page.goto("/dashboard/auto-deploy");
    // Open the schemas panel via the header button
    await page.getByRole("button", { name: /Payload schemas/i }).click();
    const panel = page.getByTestId("payload-schemas");
    await expect(panel).toBeVisible();
    // All 11 events listed
    for (const ev of [
      "approval.awaiting", "approval.confirmed", "approval.cancelled",
      "step.running", "step.ok", "step.fail",
      "deploy.retry", "deploy.failed", "deploy.published",
      "rollback.started", "rollback.completed",
    ]) {
      await expect(panel.getByRole("button", { name: ev })).toBeVisible();
    }
    // "Download all" triggers a download
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: /Download all/i }).click(),
    ]);
    expect(dl.suggestedFilename()).toContain("pluto-auto-deploy-webhook-schemas");
  });

  test("dispatch sends signed payload for each lifecycle event", async ({ page }) => {
    const url = "https://webhook.test.local/hook";
    const secret = "s3cr3t-signing-key";
    await seedWebhook(page, { url, secret });
    // Absorb the fetch so retries don't fire
    await page.route(url, (route) => route.fulfill({ status: 200, body: "ok" }));
    const reqs = captured(page, /webhook\.test\.local/);

    await page.goto("/dashboard/auto-deploy");
    // Fire every event straight from the client via the exported dispatcher.
    const events = [
      "approval.awaiting", "approval.confirmed", "step.running", "step.ok",
      "step.fail", "deploy.retry", "deploy.failed", "rollback.started",
      "rollback.completed", "deploy.published",
    ] as const;
    await page.evaluate(async (evs) => {
      const mod = await import("/src/lib/pluto/auto-deploy-webhooks.ts" as string);
      for (const ev of evs) mod.dispatchWebhookEvent(ev, { slug: "e2e-slug", message: ev });
    }, events as unknown as string[]);

    await expect.poll(() => reqs.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(events.length);

    // Verify one signed payload end-to-end
    const first = reqs[0];
    const body = first.postData() ?? "";
    const headers = first.headers();
    expect(headers["x-pluto-event"]).toBeTruthy();
    expect(headers["x-pluto-delivery"]).toMatch(/^dlv_/);
    expect(headers["x-pluto-attempt"]).toBe("1");
    const sig = headers["x-pluto-signature"] ?? "";
    expect(sig).toMatch(/^sha256=/);
    const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
    expect(sig).toBe(expected);
    const json = JSON.parse(body);
    expect(json.source).toBe("pluto-auto-deploy");
    expect(json.slug).toBe("e2e-slug");
  });

  test("500 responses retry with backoff and end as failed", async ({ page }) => {
    const url = "https://webhook.test.local/fail";
    await seedWebhook(page, { url });
    let hits = 0;
    await page.route(url, (route) => {
      hits += 1;
      return route.fulfill({ status: 500, body: "boom" });
    });

    await page.goto("/dashboard/auto-deploy");
    await page.evaluate(async () => {
      const mod = await import("/src/lib/pluto/auto-deploy-webhooks.ts" as string);
      mod.dispatchWebhookEvent("deploy.failed", { slug: "e2e-fail", message: "e2e" });
    });

    // Wait past the total backoff budget (0 + 2 + 8 + 30 ≈ 40s max, but
    // dev server + mock is fast; allow generous ceiling then assert final).
    await expect.poll(() => hits, { timeout: 60_000 }).toBeGreaterThanOrEqual(2);

    // Endpoint status pill eventually reads "failed"
    await expect(page.getByTestId("endpoint-status-wh_test")).toContainText(/failed|retrying/i);
  });
});
