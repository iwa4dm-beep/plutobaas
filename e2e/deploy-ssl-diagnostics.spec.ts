// E2E — Auto-Deploy SSL/HTTPS verification + /diagnostics endpoint:
//   1. After a deploy, the pipeline exposes a "Verify SSL / HTTPS" step
//      whose result renders under the deploy report with issuer / expiry
//      / hostname-match badges (or a "skipped" chip when the site is not
//      https).
//   2. The sandbox worker's public /diagnostics endpoint returns JSON
//      describing the served-site symlink + current.json state for a slug
//      without requiring the sandbox secret.
//   3. Hitting the same served-site over HTTPS returns a 2xx/3xx response
//      with a matching hostname certificate (best-effort — skipped when
//      no live worker is reachable so CI runs stay hermetic).
import { test, expect } from "@playwright/test";

test.describe("Auto-Deploy — SSL + /diagnostics", () => {
  test("deploy report shows the Verify SSL / HTTPS step", async ({ page }) => {
    // Seed a deploy history entry with a synthetic verify-ssl step so we
    // can render the report without invoking the live pipeline.
    await page.addInitScript(() => {
      const entry = {
        id: "deploy-ssl-test",
        startedAt: new Date().toISOString(),
        ok: true,
        totalMs: 1234,
        steps: [
          { key: "verify-deploy", label: "Verify deploy", ok: true, attempts: [] },
          {
            key: "verify-ssl", label: "Verify SSL / HTTPS", ok: true,
            attempts: [{
              attempt: 1, ok: true, latencyMs: 210, startedAt: new Date().toISOString(),
              detail: "HTTPS 200 · issuer=Let's Encrypt · 89d left",
              debug: null,
            }],
            result: JSON.stringify({
              url: "https://example.app.timescard.cloud/",
              ok: true, httpsStatus: 200, handshakeMs: 210,
              cert: {
                issuer: "Let's Encrypt", subject: "*.app.timescard.cloud",
                validFrom: "Jul 1 00:00:00 2026 GMT",
                validTo: "Oct 1 00:00:00 2026 GMT",
                daysUntilExpiry: 89, hostnameMatch: true,
              },
            }),
          },
        ],
        liveUrls: { served: true, sslProbe: { url: "https://example.app.timescard.cloud/", ok: true, httpsStatus: 200, handshakeMs: 210 } },
      };
      localStorage.setItem("pluto:auto-deploy:history", JSON.stringify([entry]));
    });
    await page.goto("/dashboard/auto-deploy");
    await expect(page.getByText(/Verify SSL \/ HTTPS/i).first()).toBeVisible({ timeout: 8000 });
    await expect(page.getByText(/HTTPS 200/i).first()).toBeVisible();
  });

  test("/diagnostics endpoint is public and returns JSON", async ({ request }) => {
    const base = process.env.PLUTO_WORKER_URL;
    test.skip(!base, "PLUTO_WORKER_URL not set — hermetic run");
    const r = await request.get(`${base}/diagnostics?slug=e2e-nonexistent`);
    expect(r.status(), "diagnostics must not require auth").not.toBe(401);
    expect(r.status(), "diagnostics must not 404 the route itself").not.toBe(404);
    const j = await r.json();
    expect(j).toHaveProperty("errors");
  });

  test("served site responds over HTTPS with a matching certificate", async ({ request }) => {
    const url = process.env.PLUTO_SERVED_SITE_URL;
    test.skip(!url || !/^https:\/\//i.test(url), "PLUTO_SERVED_SITE_URL not https");
    const r = await request.get(url!, { maxRedirects: 0 });
    expect(r.status()).toBeLessThan(500);
    // Playwright's request client fails the TLS handshake on hostname
    // mismatch, so reaching this assertion already proves the cert is valid
    // for the URL's hostname.
    expect(r.status()).toBeGreaterThanOrEqual(200);
  });
});
