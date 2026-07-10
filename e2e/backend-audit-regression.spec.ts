// Regression — OPTIONS /admin/v1/workspaces and GET /rest/v1/ must not be
// reported as failing when the upstream returns their documented non-2xx
// statuses (CORS preflight 204, PostgREST root 400/401). Also asserts the
// auto-refresh selector is present on the panel.
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

test("OPTIONS admin workspaces and GET rest root report OK without false failures", async ({ page }) => {
  await mockAudit(page, {
    ok: true, configured: true, upstreamUrl: "https://api.example.com",
    issues: [], reachable: true, failingCount: 0,
    config: { timeoutMs: 3500, maxRetries: 1, baseDelayMs: 200 },
    lastOkAt: Date.now(), lastErrorAt: null, lastError: null, lastPath: null,
    checkedAt: Date.now(),
    results: [
      {
        path: "/admin/v1/workspaces", label: "Admin · workspaces", method: "OPTIONS",
        ok: true, status: 204, latencyMs: 22, error: null, bodySnippet: null,
        attempts: [{ attempt: 1, ok: true, status: 204, latencyMs: 22, error: null, waitedMs: 0 }],
        retriedCount: 0,
      },
      {
        path: "/rest/v1/", label: "REST · root", method: "GET",
        ok: true, status: 400, latencyMs: 30, error: null, bodySnippet: null,
        attempts: [{ attempt: 1, ok: true, status: 400, latencyMs: 30, error: null, waitedMs: 0 }],
        retriedCount: 0,
      },
    ],
  });
  await page.goto("/dashboard/workspaces");
  const panel = page.getByTestId("backend-audit-panel");
  await expect(panel.getByTestId("audit-status-badge")).toContainText(/healthy/i);
  const admin = panel.getByTestId("audit-row-/admin/v1/workspaces");
  await expect(admin).toContainText("OK");
  await expect(admin).toContainText("204");
  const rest = panel.getByTestId("audit-row-/rest/v1/");
  await expect(rest).toContainText("OK");
  await expect(rest).toContainText("400");
  // Auto-refresh control is present.
  await expect(panel.getByTestId("audit-auto-refresh")).toBeVisible();
});
