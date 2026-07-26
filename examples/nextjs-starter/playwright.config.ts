import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  use: { baseURL: process.env.STARTER_URL ?? "http://localhost:3000" },
  webServer: process.env.CI
    ? {
        command: "npm run build && npm run start",
        url: "http://localhost:3000",
        reuseExistingServer: false,
        timeout: 120_000,
      }
    : undefined,
});
