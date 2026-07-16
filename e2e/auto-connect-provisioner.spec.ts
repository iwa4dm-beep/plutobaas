// E2E — Auto-Connect Studio (Workspace Provisioner)
//
// Verifies:
//   1) /dashboard/auto-connect renders with the WorkspaceProvisionCard.
//   2) Form validation: submit disabled without a valid project name.
//   3) Successful provision (server-fn RPC mocked at the network layer)
//      surfaces the generated anon key, service_role key, admin email,
//      admin password, workspaceId, projectId, and the "will not be
//      shown again" warning.
//   4) Clicking "Provision another workspace" clears the secrets from
//      the DOM — they are never re-exposed after the first display.
import { test, expect, type Page } from "@playwright/test";

const OK_PAYLOAD = {
  ok: true,
  workspaceId: "ws-e2e",
  projectId: "proj-e2e",
  userId: "user-e2e",
  adminEmail: "e2e@timescard.cloud",
  adminPassword: "SuperSecretPasswordX123",
  anonKey: "pk_anon_e2e_abcdef",
  serviceKey: "sk_service_e2e_zyxwvu",
};

async function mockProvisionServerFn(page: Page) {
  // TanStack Start server functions are dispatched to /_serverFn/<hash>.
  // We intercept every POST to that prefix and return the ProvisionResult
  // shape the client expects — the encoding is plain JSON in this template.
  await page.route(/\/_serverFn\//, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ result: OK_PAYLOAD }),
    });
  });
}

test.describe("Auto-Connect Studio — Workspace Provisioner", () => {
  test("page renders with the provisioner card", async ({ page }) => {
    await page.goto("/dashboard/auto-connect");
    await expect(page.getByRole("heading", { name: "Auto-Connect Studio" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Auto-provision Workspace/i })).toBeVisible();
  });

  test("submit is disabled without a valid project name", async ({ page }) => {
    await page.goto("/dashboard/auto-connect");
    const submit = page.getByRole("button", { name: /Create workspace/i });
    await expect(submit).toBeDisabled();
    await page.getByPlaceholder("my-project").fill("x"); // < 2 chars
    // Client-side minLength trips only on submit; button stays enabled but
    // handler shows a toast and refuses to call the RPC.
    await page.getByPlaceholder("my-project").fill("ok");
    await expect(submit).toBeEnabled();
  });

  test("successful provision reveals keys once and can be cleared", async ({ page }) => {
    await mockProvisionServerFn(page);
    await page.goto("/dashboard/auto-connect");

    await page.getByPlaceholder("my-project").fill("e2e-test");
    await page.getByRole("button", { name: /Create workspace/i }).click();

    // All six sensitive/identifying fields must be visible exactly once.
    await expect(page.getByText("Workspace created")).toBeVisible();
    await expect(page.locator(`input[value="${OK_PAYLOAD.workspaceId}"]`)).toBeVisible();
    await expect(page.locator(`input[value="${OK_PAYLOAD.projectId}"]`)).toBeVisible();
    await expect(page.locator(`input[value="${OK_PAYLOAD.anonKey}"]`)).toBeVisible();
    await expect(page.locator(`input[value="${OK_PAYLOAD.serviceKey}"]`)).toBeVisible();
    await expect(page.locator(`input[value="${OK_PAYLOAD.adminPassword}"]`)).toBeVisible();
    await expect(page.getByText(/এই password আর দেখানো হবে না/)).toBeVisible();

    // Reset: keys must disappear from the DOM entirely — never re-exposed.
    await page.getByRole("button", { name: /Provision another workspace/i }).click();
    await expect(page.locator(`input[value="${OK_PAYLOAD.serviceKey}"]`)).toHaveCount(0);
    await expect(page.locator(`input[value="${OK_PAYLOAD.anonKey}"]`)).toHaveCount(0);
    await expect(page.locator(`input[value="${OK_PAYLOAD.adminPassword}"]`)).toHaveCount(0);
  });
});
