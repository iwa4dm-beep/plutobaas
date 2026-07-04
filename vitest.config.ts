import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Root vitest runs only frontend/SDK unit tests. The backend package
// (backend/apps/server) ships its own integration/RLS suites that need
// Postgres + fastify + pg installed in that workspace — those run in a
// separate CI job (see .github/workflows/ci.yml).
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["**/node_modules/**", "backend/**"],
    environment: "node",
  },
});
