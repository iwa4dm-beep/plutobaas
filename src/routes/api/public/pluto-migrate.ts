// Public endpoint to push the tenant migration bundle to the VPS Pluto
// backend using the service role key.
//
// SECURITY: this handler executes SQL with `allow_dangerous` /
// `confirm_destructive` on the VPS via the service-role credential.
// It MUST require a valid service bearer token — the previous version
// accepted anonymous GETs, which meant anyone hitting the public URL
// could run the destructive migration bundle. Verb is also POST since
// this is a mutating action, not a read.
import { createFileRoute } from "@tanstack/react-router";
import { isValidServiceToken, vpsFetch } from "@/lib/pluto/vps-client";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — vite ?raw import
import migrationSql from "@/../pluto-backend/migrations/tenants/0001_dbh_dubaiborkahouse.sql?raw";

type ExecResult = {
  ok?: boolean;
  row_count?: number;
  duration_ms?: number;
  error?: string;
  message?: string;
  classifications?: unknown;
};

async function runMigration(request: Request) {
  const token = request.headers.get("authorization") ?? "";
  if (!(await isValidServiceToken(token))) {
    return new Response(
      JSON.stringify({ ok: false, error: "unauthorized" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  const sql = String(migrationSql);
  const bytes = sql.length;
  try {
    const res = await vpsFetch<ExecResult>("/admin/v1/sql/exec", {
      method: "POST",
      mode: "service",
      timeoutMs: 120_000,
      body: {
        sql,
        read_only: false,
        allow_dangerous: true,
        confirm_destructive: true,
      },
    });
    return new Response(
      JSON.stringify({ ok: true, bytes, result: res }, null, 2),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  } catch (e: unknown) {
    const err = e as { status?: number; body?: unknown; message?: string };
    return new Response(
      JSON.stringify(
        { ok: false, bytes, status: err.status ?? 0, error: err.message, body: err.body },
        null, 2,
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
}

export const Route = createFileRoute("/api/public/pluto-migrate")({
  server: {
    handlers: {
      POST: async ({ request }) => runMigration(request),
    },
  },
});
