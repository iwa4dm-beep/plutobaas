// E2E — Getting Started → Auto-Connect Studio sidebar navigation.
//
// The Auto-Connect Studio page lives under the dashboard layout at
// /dashboard/auto-connect, so the sidebar is mounted on that route and its
// active/aria-current highlighting must follow the pathname.
import { test, expect, type Page } from "@playwright/test";

const SESSION_KEY = "pluto.session.v1";
const AUTO_CONNECT_PATH = "/dashboard/auto-connect";
const fakeSession = {
  access_token: "e2e.fake.token",
  refresh_token: "e2e.fake.refresh",
  expires_at: Math.floor(Date.now() / 1000) + 60 * 60,
  user: {
    id: "00000000-0000-0000-0000-000000000001",
    email: "e2e@example.com",
    role: "admin",
    created_at: new Date().toISOString(),
    email_verified: true,
    email_confirmed_at: new Date().toISOString(),
  },
};

async function primeSession(page: Page) {
  await page.goto("/");
  await page.evaluate(
    ([key, value, tourKey]) => {
      window.localStorage.setItem(key, value);
      window.localStorage.setItem(tourKey, "1");
    },
    [SESSION_KEY, JSON.stringify(fakeSession), "pluto:help:onboarded"] as const,
  );
  await page.route("**/api/pluto/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

async function expandGettingStarted(page: Page) {
  const link = page.getByRole("link", { name: "Auto-Connect Studio" });
  if (await link.first().isVisible().catch(() => false)) return;
  await page.getByRole("button", { name: "Getting Started" }).first().click();
  await expect(link.first()).toBeVisible();
}

test.describe("Sidebar → Auto-Connect Studio", () => {
  test("desktop: click navigates and page renders", async ({ page }) => {
    await primeSession(page);
    await page.goto("/dashboard");
    await expandGettingStarted(page);

    const link = page.getByRole("link", { name: "Auto-Connect Studio" }).first();
    await expect(link).toHaveAttribute("href", AUTO_CONNECT_PATH);
    await link.click();
    await page.waitForURL(`**${AUTO_CONNECT_PATH}`);
    await expect(page.getByRole("heading", { name: "Auto-Connect Studio", level: 1 })).toBeVisible();
    await expect(page).toHaveTitle(/Auto-Connect Studio/);
  });

  test("direct URL: sidebar item is active on first load without any clicks", async ({ page }) => {
    await primeSession(page);
    await page.goto(AUTO_CONNECT_PATH);
    // Group containing the active child auto-expands, so no manual click needed.
    const link = page.getByRole("link", { name: "Auto-Connect Studio" }).first();
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("aria-current", "page");
  });

  test("round-trip: aria-current updates when leaving and returning", async ({ page }) => {
    await primeSession(page);
    await page.goto(AUTO_CONNECT_PATH);
    const link = page.getByRole("link", { name: "Auto-Connect Studio" }).first();
    await expect(link).toHaveAttribute("aria-current", "page");

    // Navigate to Overview (a sibling dashboard route) and confirm it clears.
    await page.getByRole("link", { name: "Overview", exact: true }).first().click();
    await page.waitForURL("**/dashboard");
    await expect(page.getByRole("link", { name: "Auto-Connect Studio" }).first())
      .not.toHaveAttribute("aria-current", "page");

    // Return via sidebar and confirm active state comes back.
    await expandGettingStarted(page);
    await page.getByRole("link", { name: "Auto-Connect Studio" }).first().click();
    await page.waitForURL(`**${AUTO_CONNECT_PATH}`);
    await expect(page.getByRole("link", { name: "Auto-Connect Studio" }).first())
      .toHaveAttribute("aria-current", "page");
  });

  test("keyboard: focus the link with Tab and activate with Enter", async ({ page }) => {
    await primeSession(page);
    await page.goto("/dashboard");
    await expandGettingStarted(page);

    const link = page.getByRole("link", { name: "Auto-Connect Studio" }).first();
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press("Enter");
    await page.waitForURL(`**${AUTO_CONNECT_PATH}`);
    await expect(page.getByRole("link", { name: "Auto-Connect Studio" }).first())
      .toHaveAttribute("aria-current", "page");
  });

  test("mobile: drawer exposes the link and stays usable while page loads", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await primeSession(page);
    await page.goto("/dashboard");

    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Open menu" }).click({ force: true });
    await expandGettingStarted(page);

    const link = page.getByRole("link", { name: "Auto-Connect Studio" }).first();
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(`**${AUTO_CONNECT_PATH}`);
    // No blank-screen fallback: the h1 renders and the mobile menu button
    // (in the dashboard header) is still reachable for further navigation.
    await expect(page.getByRole("heading", { name: "Auto-Connect Studio", level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open menu" })).toBeVisible();
  });
});
