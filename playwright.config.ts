import { defineConfig, devices } from "@playwright/test";

// E2E tests for the Pluto dashboard. These run against the local Vite dev
// server and mock all Pluto SDK network calls at the fetch level, so they
// do not need a running backend — CI can execute them without provisioning
// Postgres. To run manually: `bun run test:e2e` (starts dev server too).
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:8080",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run dev",
    port: 8080,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
