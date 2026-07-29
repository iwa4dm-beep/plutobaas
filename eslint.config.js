import js from "@eslint/js";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".output", ".vinxi"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "server-only",
              message:
                "TanStack Start does not use the Next.js `server-only` package. Rename the module to `*.server.ts` or mark it with `@tanstack/react-start/server-only`.",
            },
          ],
        },
      ],
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Server-only runtime modules must not be statically imported from files
    // that can be reached from a client route. Only `*.server.ts(x)` modules,
    // the SSR entry, and API routes may do so.
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/**/*.server.{ts,tsx}", "src/server.ts", "src/routes/api/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@tanstack/react-start/server", "node:async_hooks", "**/*.server"],
              message:
                "Server-only import in a client-reachable file. Move the logic into a `*.server.ts` module and expose it via createServerOnlyFn (see src/lib/pluto/request-context.ts).",
            },
          ],
        },
      ],
    },
  },
  eslintPluginPrettier,
);
