// E2E — BackendAuditPanel renders the /api/pluto/audit health matrix,
// including expandable per-route failure details and the last failure reason.
import { test, expect, type Page } from "@playwright/test";

async function mockAudit(page: Page, body: unknown) {
  await page.route("**/api/pluto/audit*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    });
  });
}

test.describe("BackendAuditPanel", () => {
  test("renders healthy matrix with per-route rows", async ({ page }) => {
    await mockAudit(page, {
      ok: true, configured: true, upstreamUrl: "https://api.example.com",
      issues: [], reachable: true, failingCount: 0,
      config: { timeoutMs: 3500, maxRetries: 1, baseDelayMs: 200 },
      lastOkAt: Date.now(), lastErrorAt: null, lastError: null, lastPath: null,
      checkedAt: Date.now(),
      results: [
        { path: "/readyz", label: "Liveness (readyz)", method: "GET", ok: true, status: 200, latencyMs: 12, error: null, bodySnippet: null, attempts: [{ attempt: 1, ok: true, status: 200, latencyMs: 12, error: null, waitedMs: 0 }], retriedCount: 0 },
        { path: "/rest/v1/", label: "REST · root", method: "GET", ok: true, status: 401, latencyMs: 19, error: null, bodySnippet: null, attempts: [{ attempt: 1, ok: true, status: 401, latencyMs: 19, error: null, waitedMs: 0 }], retriedCount: 0 },
      ],
    });
    await page.goto("/dashboard/workspaces");
    const panel = page.getByTestId("backend-audit-panel");
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("audit-status-badge")).toContainText(/healthy/i);
    await expect(panel.getByTestId("audit-row-/readyz")).toContainText("Liveness (readyz)");
    await expect(panel.getByTestId("audit-row-/readyz")).toContainText("OK");
  });

  test("shows last failure reason and expandable per-route details", async ({ page }) => {
    await mockAudit(page, {
      ok: false, configured: true, upstreamUrl: "https://api.example.com",
      issues: [], reachable: false, failingCount: 1,
      config: { timeoutMs: 3500, maxRetries: 2, baseDelayMs: 200 },
      lastOkAt: Date.now() - 60_000,
      lastErrorAt: Date.now(),
      lastError: "ECONNREFUSED at admin/v1/workspaces",
      lastPath: "/admin/v1/workspaces",
      checkedAt: Date.now(),
      results: [
        {
          path: "/admin/v1/workspaces", label: "Admin · workspaces", method: "OPTIONS",
          ok: false, status: 502, latencyMs: 240,
          error: "unexpected status 502",
          bodySnippet: '{"error":"bad_gateway","message":"upstream refused"}',
          retriedCount: 2,
          attempts: [
            { attempt: 1, ok: false, status: 502, latencyMs: 200, error: "unexpected status 502", waitedMs: 0 },
            { attempt: 2, ok: false, status: 502, latencyMs: 210, error: "unexpected status 502", waitedMs: 200 },
            { attempt: 3, ok: false, status: 502, latencyMs: 240, error: "unexpected status 502", waitedMs: 400 },
          ],
        },
      ],
    });
    await page.goto("/dashboard/workspaces");
    const panel = page.getByTestId("backend-audit-panel");
    await expect(panel.getByTestId("audit-status-badge")).toContainText(/1 failing/i);
    await expect(panel.getByTestId("audit-last-failure")).toContainText("ECONNREFUSED at admin/v1/workspaces");

    const row = panel.getByTestId("audit-row-/admin/v1/workspaces");
    await expect(row).toContainText("FAIL");
    await expect(row).toContainText("502");

    // Expand details.
    await row.click();
    const detail = panel.getByTestId("audit-detail-/admin/v1/workspaces");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("Attempts");
    await expect(detail).toContainText("Response body");
    await expect(detail).toContainText("upstream refused");
  });
});
