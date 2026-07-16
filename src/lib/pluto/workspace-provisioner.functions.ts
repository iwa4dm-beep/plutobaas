// Server function: automatically provision a workspace + admin user on VPS.
//
// Uses the backend's transactional `POST /auth/v1/signup-full` which creates
// user + workspace + project + api keys in a single atomic call and returns
// the keys ONCE. This replaces the previous 3-step flow that relied on a
// non-existent `/auth/v1/admin/users` endpoint.
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
  projectId: string;
  adminEmail: string;
  adminPassword: string;
  userId: string;
  anonKey: string;
  serviceKey: string;
} | {
  ok: false;
  step: "signup";
  error: string;
  status: number;
};

function genPassword(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#%&*";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join("");
}

type SignupFullResponse = {
  user: { id: string; email: string };
  workspace: { id: string; slug: string; name: string };
  project: { id: string; slug: string; name: string };
  keys: { anon: string; service_role: string };
};

// Extracted for direct unit testing (vitest can't call a createServerFn
// wrapper because it needs a Start AsyncLocalStorage context).
export async function provisionWorkspaceCore(
  data: { projectName: string; adminEmail?: string },
): Promise<ProvisionResult> {
  const adminEmail = data.adminEmail ?? `admin+${Date.now().toString(36)}@timescard.cloud`;
  const adminPassword = genPassword();

  try {
    const res = await vpsFetch<SignupFullResponse>("/auth/v1/signup-full", {
      method: "POST",
      mode: "anon",
      body: {
        email: adminEmail,
        password: adminPassword,
        workspace_name: data.projectName,
        seed_demo: false,
      },
    });
    return {
      ok: true,
      workspaceId: res.workspace.id,
      projectId: res.project.id,
      adminEmail: res.user.email,
      adminPassword,
      userId: res.user.id,
      anonKey: res.keys.anon,
      serviceKey: res.keys.service_role,
    };
  } catch (e) {
    const err = e instanceof VpsError ? e : new VpsError(String(e), 500, null);
    return { ok: false, step: "signup", error: err.message, status: err.status };
  }
}

export const provisionWorkspace = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => InputSchema.parse(data))
  .handler(async ({ data }): Promise<ProvisionResult> => provisionWorkspaceCore(data));

