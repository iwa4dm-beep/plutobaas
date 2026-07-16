// Verifies that `provisionWorkspace` calls the public
// `POST /auth/v1/signup-full` endpoint WITHOUT requiring
// PLUTO_SERVICE_ROLE_KEY, and that the returned payload includes the
// generated anon + service_role keys (returned exactly once by the backend).
//
// The card component in `WorkspaceProvisionCard.tsx` renders those keys once
// and then clears them from React state when "Provision another workspace"
// is clicked — they are never persisted anywhere else in the client.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { provisionWorkspaceCore as provisionWorkspace } from "./workspace-provisioner.functions";

type FetchArgs = { url: string; init: RequestInit | undefined };

function stubFetch(response: unknown, status = 200) {
  const calls: FetchArgs[] = [];
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { calls, spy };
}

describe("provisionWorkspace (Auto-Connect Studio)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Critical: ensure service role key is NOT set — the public signup-full
    // endpoint must succeed without it.
    delete process.env.PLUTO_SERVICE_ROLE_KEY;
    delete process.env.PLUTO_ANON_KEY;
    process.env.PLUTO_UPSTREAM_URL = "https://api.timescard.cloud";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("succeeds and returns anon + service_role keys without PLUTO_SERVICE_ROLE_KEY", async () => {
    const { calls } = stubFetch({
      user: { id: "u-1", email: "auto@test.dev" },
      workspace: { id: "ws-1", slug: "e2e", name: "e2e" },
      project: { id: "proj-1", slug: "default", name: "default" },
      keys: { anon: "pk_anon_xxx", service_role: "sk_service_yyy" },
    });

    const result = await provisionWorkspace({
      projectName: "e2e-test",
      adminEmail: "auto@test.dev",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.timescard.cloud/auth/v1/signup-full");
    // Anon mode: must NOT send a service-role bearer.
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBeNull();

    if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
    expect(result).toMatchObject({
      ok: true,
      workspaceId: "ws-1",
      projectId: "proj-1",
      userId: "u-1",
      adminEmail: "auto@test.dev",
      anonKey: "pk_anon_xxx",
      serviceKey: "sk_service_yyy",
    });
    // Password is generated client-side, never fetched from backend.
    expect(result.adminPassword).toMatch(/^.{20}$/);
  });

  it("surfaces backend failures without leaking service key requirement", async () => {
    stubFetch({ error: "email already registered" }, 409);
    const result = await provisionWorkspace({
      projectName: "e2e-dup",
      adminEmail: "dup@test.dev",
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.step).toBe("signup");
    expect(result.status).toBe(409);
    expect(result.error).not.toMatch(/PLUTO_SERVICE_ROLE_KEY/);
  });

  it("auto-generates admin email when none is provided", async () => {
    const { calls } = stubFetch({
      user: { id: "u-2", email: "any@x" },
      workspace: { id: "ws-2", slug: "s", name: "s" },
      project: { id: "p-2", slug: "d", name: "d" },
      keys: { anon: "a", service_role: "s" },
    });
    await provisionWorkspace({ projectName: "no-email" });
    const body = JSON.parse(calls[0].init?.body as string);
    expect(body.email).toMatch(/^admin\+[a-z0-9-]+@timescard\.cloud$/);
    expect(body.workspace_name).toBe("no-email");
    expect(body.seed_demo).toBe(false);
  });
});
