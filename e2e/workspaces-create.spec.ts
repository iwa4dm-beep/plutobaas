// E2E — Workspace creation flow.
// Covers:
//   1) Successful create with a valid lowercase slug shows the "Copy your key(s)" dialog.
//   2) Backend Zod-style rejection surfaces as a visible error message.
//   3) UI slug validation auto-lowercases and disables submit for invalid slugs.
//
// Mocks all Pluto SDK calls at the fetch level; no live backend required.
import { test, expect, type Page } from "@playwright/test";

const PLUTO_URL = "http://pluto.mock";

async function installMocks(page: Page) {
  await page.addInitScript((url) => {
    const realFetch = window.fetch.bind(window);
    const state = { workspaces: [] as Array<Record<string, unknown>> };
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status, headers: { "content-type": "application/json" },
      });

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      // Backend audit + status endpoints — same-origin.
      if (u.includes("/api/pluto/audit")) {
        return json({
          ok: true, configured: true, upstreamUrl: url,
          issues: [], reachable: true, failingCount: 0,
          results: [
            { path: "/readyz", label: "Liveness (readyz)", ok: true, status: 200, latencyMs: 12, error: null },
            { path: "/admin/v1/workspaces", label: "Admin · workspaces", ok: true, status: 204, latencyMs: 14, error: null },
          ],
          lastOkAt: Date.now(), lastErrorAt: null, lastError: null, lastPath: null,
          checkedAt: Date.now(),
        });
      }

      if (!u.includes(url)) return realFetch(input, init);
      const path = u.replace(url, "").replace(/^https?:\/\/[^/]+/, "");

      if (path === "/admin/v1/workspaces" && method === "GET") {
        return json({ workspaces: state.workspaces });
      }
      if (path === "/admin/v1/workspaces" && method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}") as { slug?: string; name?: string };
        const slug = body.slug ?? "";
        // Mirror the real backend Zod contract: lowercase slug, 2-63 chars.
        if (!/^[a-z0-9_-]{2,63}$/.test(slug)) {
          return json({
            error: "ZodError",
            message: JSON.stringify([{
              validation: "regex", code: "invalid_string",
              message: "lowercase slug, 2-63 chars", path: ["slug"],
            }]),
            statusCode: 500,
          }, 500);
        }
        const ws = {
          id: `ws-${slug}`, slug, name: body.name ?? slug,
          created_at: new Date().toISOString(), archived_at: null,
          member_count: 1, active_keys: 2,
          keys: { anon: `pk_anon_${slug}_xyz`, service_role: `sk_service_${slug}_xyz` },
        };
        state.workspaces.push(ws);
        return json(ws);
      }
      if (path.match(/^\/admin\/v1\/workspaces\/[^/]+\/keys$/) && method === "GET") {
        return json({ keys: [] });
      }
      if (path.match(/^\/admin\/v1\/workspaces\/[^/]+\/members$/) && method === "GET") {
        return json({ members: [] });
      }
      if (path === "/admin/v1/projects" && method === "GET") return json([]);

      return json({}, 200);
    };
  }, PLUTO_URL);
}

test.describe("workspace creation", () => {
  test("successful create with lowercase slug shows fresh keys dialog", async ({ page }) => {
    await installMocks(page);
    await page.goto("/dashboard/workspaces");

    await page.getByRole("button", { name: /New/ }).first().click();
    await page.getByPlaceholder("acme-prod").fill("acme-prod");
    await page.getByPlaceholder("Acme production").fill("Acme production");

    const createBtn = page.getByRole("button", { name: /^Create$/ });
    await expect(createBtn).toBeEnabled();
    await createBtn.click();

    await expect(page.getByText(/Copy your key\(s\) now/i)).toBeVisible();
    await expect(page.getByText(/pk_anon_acme-prod_xyz/)).toBeVisible();
  });

  test("invalid slug is rejected client-side (submit disabled)", async ({ page }) => {
    await installMocks(page);
    await page.goto("/dashboard/workspaces");

    await page.getByRole("button", { name: /New/ }).first().click();
    // User types capitals → input auto-lowercases via onChange.
    const slugInput = page.getByPlaceholder("acme-prod");
    await slugInput.fill("A"); // single char after lowercase → fails min length
    await page.getByPlaceholder("Acme production").fill("Test");

    await expect(slugInput).toHaveValue("a");
    await expect(page.getByRole("button", { name: /^Create$/ })).toBeDisabled();
  });

  test("backend rejection surfaces the Zod error in the dialog", async ({ page }) => {
    await installMocks(page);
    await page.goto("/dashboard/workspaces");

    // Bypass the client-side regex by dispatching input directly with a value
    // the sanitizer would reject — we simulate a legacy value slipping through
    // by writing a value that passes /^[a-z0-9_-]{2,63}$/ but the mock rejects.
    // The mock rejects an empty slug; we test the real error surface by
    // programmatically calling the SDK create through a valid slug that the
    // mock is patched to reject.
    await page.route(`${PLUTO_URL}/admin/v1/workspaces`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: "ZodError",
          message: '[{"validation":"regex","code":"invalid_string","message":"lowercase slug, 2-63 chars","path":["slug"]}]',
          statusCode: 500,
        }),
      });
    });

    await page.getByRole("button", { name: /New/ }).first().click();
    await page.getByPlaceholder("acme-prod").fill("valid-slug");
    await page.getByPlaceholder("Acme production").fill("Rejected");
    await page.getByRole("button", { name: /^Create$/ }).click();

    // The dialog surfaces the raw backend message rather than "Backend unreachable".
    await expect(page.getByText(/lowercase slug, 2-63 chars/)).toBeVisible();
  });
});
