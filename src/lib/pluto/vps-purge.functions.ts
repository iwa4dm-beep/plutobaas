// VPS site-directory purge — deletes a slug's entire /var/lib/pluto/sites/<slug>
// (releases, symlinks, secrets) via the sandbox worker's authenticated
// POST /admin/purge-slug. Called when a project is deleted from the dashboard
// so the VPS artifacts vanish instantly, not just the DB row.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requirePlutoAdmin } from "./admin-middleware";
import { getVpsBaseUrl } from "./vps-client";

function envFirst(...keys: string[]): string {
  for (const k of keys) {
    const v = process.env[k];
    if (v && v.trim()) return v.trim();
  }
  return "";
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const Input = z.object({
  slug: z.string().trim().toLowerCase().refine((s) => SLUG_RE.test(s), "invalid slug"),
});

export type PurgeSlugResult = {
  ok: boolean;
  slug: string;
  removed: string[];
  errors: string[];
  purgedAt: string;
  hint: string | null;
};

export const purgeVpsSlug = createServerFn({ method: "POST" })
  .middleware([requirePlutoAdmin])
  .inputValidator((d: unknown) => Input.parse(d))
  .handler(async ({ data }): Promise<PurgeSlugResult> => {
    const base = getVpsBaseUrl();
    const sandboxUrl = (envFirst("PLUTO_SANDBOX_URL") || `${base}/sandbox`).replace(/\/+$/, "");
    const secret = envFirst("PLUTO_SANDBOX_SECRET", "PLUTO_SANDBOX_WORKER_SECRET", "SANDBOX_SHARED_SECRET");
    const now = new Date().toISOString();
    if (!secret) {
      return {
        ok: false, slug: data.slug, removed: [], errors: ["missing_sandbox_secret"],
        purgedAt: now,
        hint: "PLUTO_SANDBOX_SECRET is not set in Lovable Cloud → Secrets. Run `sudo bash pluto-backend/deploy/print-sandbox-secret.sh` on the VPS and paste the value.",
      };
    }
    try {
      const r = await fetch(`${sandboxUrl}/admin/purge-slug`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-sandbox-secret": secret,
        },
        body: JSON.stringify({ slug: data.slug }),
      });
      const text = await r.text();
      let parsed: Partial<PurgeSlugResult> & { error?: string } = {};
      try { parsed = JSON.parse(text); } catch { /* keep raw */ }
      if (!r.ok && r.status !== 207) {
        let hint: string | null = null;
        if (r.status === 401) hint = "Sandbox secret mismatch. Sync PLUTO_SANDBOX_SECRET with VPS SANDBOX_SHARED_SECRET.";
        else if (r.status === 404) hint = "Worker does not expose /admin/purge-slug — pull latest and rerun bootstrap-sandbox-worker.sh on the VPS.";
        else if (r.status === 400) hint = parsed.error ?? "Bad request (invalid slug).";
        return {
          ok: false, slug: data.slug, removed: [], errors: [parsed.error ?? `HTTP ${r.status}`],
          purgedAt: now, hint,
        };
      }
      return {
        ok: parsed.ok ?? r.ok,
        slug: data.slug,
        removed: Array.isArray(parsed.removed) ? parsed.removed : [],
        errors: Array.isArray(parsed.errors) ? parsed.errors : [],
        purgedAt: typeof parsed.purgedAt === "string" ? parsed.purgedAt : now,
        hint: (parsed.errors && parsed.errors.length)
          ? "Some paths could not be removed — check `errors` and rerun, or inspect /var/lib/pluto/sites on the VPS."
          : null,
      };
    } catch (e) {
      return {
        ok: false, slug: data.slug, removed: [], errors: [(e as Error).message],
        purgedAt: now,
        hint: `Network error contacting sandbox worker: ${(e as Error).message}`,
      };
    }
  });
