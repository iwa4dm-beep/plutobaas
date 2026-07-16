// E2E — Auto-Deploy Studio: approval gate blocks deployment until confirmed.
//
// Verifies:
//   1. Uploading a ZIP progresses through analyze → plan → bundle and stops
//      at "Awaiting approval" — the deployAll server function must NOT have
//      been called yet.
//   2. Clicking "Confirm & deploy" triggers the RPC exactly once and the
//      pipeline advances to the live/success UI, with the audit-trail entry
//      recording the approver.
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import JSZip from "jszip";

const FIXTURE_DIR = path.resolve(process.cwd(), "e2e/.fixtures");
const FIXTURE_ZIP = path.join(FIXTURE_DIR, "auto-deploy-sample.zip");

async function buildFixtureZip(): Promise<void> {
  if (fs.existsSync(FIXTURE_ZIP)) return;
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const zip = new JSZip();
  zip.file("composer.json", JSON.stringify({ name: "acme/app", require: { "laravel/framework": "^10.0" } }));
  zip.file(
    "database/migrations/2024_01_01_000000_create_tasks_table.php",
    `<?php
use Illuminate\\Database\\Migrations\\Migration;
use Illuminate\\Database\\Schema\\Blueprint;
use Illuminate\\Support\\Facades\\Schema;
return new class extends Migration {
  public function up(): void {
    Schema::create('tasks', function (Blueprint $t) {
      $t->id();
      $t->string('title');
      $t->boolean('done')->default(false);
      $t->timestamps();
    });
  }
};
`,
  );
  zip.file("routes/api.php", `<?php Route::get('/tasks', [TaskController::class, 'index']);`);
  zip.file("package.json", JSON.stringify({ name: "app-frontend", scripts: { build: "vite build" } }));
  zip.file("resources/js/app.js", "console.log('hi');");
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  fs.writeFileSync(FIXTURE_ZIP, buf);
}

let deployCalls = 0;
async function mockDeploy(page: Page, opts: { ok?: boolean; healthy?: boolean } = {}) {
  const ok = opts.ok ?? true;
  const healthy = opts.healthy ?? true;
  await page.route(/\/_serverFn\//, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    deployCalls += 1;
    const now = new Date().toISOString();
    const steps = [
      "ensureInfra", "push-migrations", "upload-bundle", "verify-deploy",
      "unpack-serve", "activate-service", "health-check",
    ].map((k) => ({
      key: k,
      label: k,
      ok,
      attempts: [{ attempt: 1, ok, latencyMs: 10, startedAt: now, detail: "mocked" }],
      result: k === "health-check"
        ? JSON.stringify({
            runtime: { status: healthy ? 200 : 500, body: healthy ? "ok" : "fail" },
            invoke: { status: healthy ? 200 : 500, body: healthy ? "ok" : "err" },
            site: { status: healthy ? 200 : 502, url: "https://mock.local", snippet: "" },
          })
        : "",
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        result: {
          ok,
          steps,
          totalMs: 1234,
          liveUrls: {
            functionsHealth: "https://mock.local/health",
            bootstrapInvoke: "https://mock.local/invoke",
          },
        },
      }),
    });
  });
}

test.describe("Auto-Deploy Studio — Approval Gate", () => {
  test.beforeAll(async () => { await buildFixtureZip(); });
  test.beforeEach(() => { deployCalls = 0; });

  test("blocks deployment until user confirms, then completes pipeline", async ({ page }) => {
    await mockDeploy(page, { ok: true, healthy: true });
    await page.goto("/dashboard/auto-deploy");

    // Pick ZIP source
    await page.getByRole("button", { name: /ZIP upload/i }).click();
    await page.setInputFiles('input[type="file"]', FIXTURE_ZIP);

    // Kick off analyze → plan → bundle → stop
    await page.getByRole("button", { name: /Analyze & Prepare/i }).click();

    // Approval panel appears
    await expect(page.getByText(/Approval required/i)).toBeVisible({ timeout: 30_000 });

    // Assert: deploy RPC was NOT called before approval
    expect(deployCalls).toBe(0);

    // Confirm & deploy
    await page.getByRole("button", { name: /Confirm & deploy/i }).click();

    // Live URL appears
    await expect(page.getByText(/Live — deploy সফল|Live — deploy/i)).toBeVisible({ timeout: 30_000 });
    expect(deployCalls).toBe(1);

    // Audit trail includes an approval entry
    await expect(page.getByTestId("audit-trail")).toContainText(/DEPLOY/);
  });
});
