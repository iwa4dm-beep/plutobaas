// E2E — MigrationRunner streams logs, updates the progress bar / current step
// in real time, and shows a successful completion state at the end.
import { test, expect, type Page } from "@playwright/test";

async function mockAudit(page: Page) {
  await page.route("**/api/pluto/audit*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, configured: true, upstreamUrl: "https://api.example.com",
        issues: [], reachable: true, failingCount: 0,
        results: [], lastOkAt: Date.now(), lastErrorAt: null,
        lastError: null, lastPath: null, checkedAt: Date.now(),
      }),
    }),
  );
}

test.describe("MigrationRunner", () => {
  test("streams progress, updates percentage, and shows successful completion", async ({ page }) => {
    await mockAudit(page);

    // Slow the SQL endpoint slightly so intermediate progress is observable.
    let count = 0;
    await page.route("**/api/pluto/v1/admin/sql", async (route) => {
      count += 1;
      await new Promise((r) => setTimeout(r, 25));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: true, applied: count }),
      });
    });

    // Also short-circuit other Pluto proxy calls that the workspaces page fires.
    await page.route("**/api/pluto/admin/v1/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
    );

    await page.goto("/dashboard/workspaces");

    // Expand the migration runner collapsible card.
    await page.getByRole("button", { name: /Database migration runner/i }).click();

    const keyInput = page.getByPlaceholder(/sk_service_/);
    await keyInput.fill("sk_service_test_e2e_key");

    const applyBtn = page.getByRole("button", { name: /Apply migration/i });
    await expect(applyBtn).toBeEnabled();
    await applyBtn.click();

    // The streaming log should appear with the initial "Starting migration" line.
    await expect(page.getByText(/Starting migration —/)).toBeVisible();

    // Progress reaches 100% within a reasonable window.
    await expect(page.getByText(/100%/)).toBeVisible({ timeout: 30_000 });

    // Completion summary is rendered.
    await expect(page.getByText(/Applied \d+ \/ \d+ statements/)).toBeVisible();

    // At least a few SQL statements were streamed to the backend.
    expect(count).toBeGreaterThan(0);
  });
});
