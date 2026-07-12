// Server function: automatically provision a workspace + admin user on VPS.
//
// Flow:
//   1. Create workspace via POST /admin/v1/workspaces
//   2. Create admin user via POST /auth/v1/admin/users (auto email + password)
//   3. Assign admin role via POST /admin/v1/workspaces/:id/members
//
// Returns generated credentials ONCE — caller must show them to the user
// and never store them plaintext.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { vpsFetch, VpsError } from "./vps-client";

const InputSchema = z.object({
  projectName: z.string().min(2).max(64),
  adminEmail: z.string().email().optional(),
});

export type ProvisionResult = {
  ok: true;
  workspaceId: string;
  adminEmail: string;
  adminPassword: string;
  userId: string;
} | {
  ok: false;
  step: "workspace" | "user" | "member";
  error: string;
  status: number;
};

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "workspace";
}

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%&*";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

export const provisionWorkspace = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }): Promise<ProvisionResult> => {
    const slug = slugify(data.projectName);
    const adminEmail = data.adminEmail ?? `admin+${slug}-${Date.now().toString(36)}@timescard.cloud`;
    const adminPassword = genPassword();

    // Step 1 — workspace
    let workspaceId = "";
    try {
      const ws = await vpsFetch<{ id: string }>("/admin/v1/workspaces", {
        method: "POST",
        body: { name: data.projectName, slug },
      });
      workspaceId = ws.id;
    } catch (e) {
      const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
      return { ok: false, step: "workspace", error: err.message, status: err.status };
    }

    // Step 2 — admin user
    let userId = "";
    try {
      const user = await vpsFetch<{ id: string }>("/auth/v1/admin/users", {
        method: "POST",
        body: {
          email: adminEmail,
          password: adminPassword,
          email_confirm: true,
          user_metadata: { source: "auto-connect", workspace_id: workspaceId },
        },
      });
      userId = user.id;
    } catch (e) {
      const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
      return { ok: false, step: "user", error: err.message, status: err.status };
    }

    // Step 3 — attach as admin
    try {
      await vpsFetch(`/admin/v1/workspaces/${workspaceId}/members`, {
        method: "POST",
        body: { user_id: userId, role: "admin" },
      });
    } catch (e) {
      const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
      return { ok: false, step: "member", error: err.message, status: err.status };
    }

    return { ok: true, workspaceId, adminEmail, adminPassword, userId };
  });
