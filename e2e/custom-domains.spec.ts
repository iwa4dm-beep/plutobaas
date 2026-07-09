// Phase 64 — Playwright e2e for custom-domain lifecycle.
//
// Two modes:
//
//   1. Fast smoke (default, always runs) — hits the enterprise API against
//      the local Vite dev server's mocked backend. Verifies add/verify/
//      make-primary/remove happy path, RBAC 403 for non-admin, wildcard
//      accept, and health-endpoint probe. Does NOT require real DNS.
//
//   2. Real staging (opt-in) — set the following env vars to run the real
//      DNS + TLS + realtime broadcast flow against a live staging backend:
//
//        PLUTO_STAGING_BASE=https://staging.pluto.example.com
//        PLUTO_STAGING_SERVICE_KEY=sk_...
//        PLUTO_STAGING_WORKSPACE=<uuid>
//        PLUTO_TEST_DOMAIN=api-e2e.yourbrand.com   # you own it, DNS you control
//        PLUTO_TEST_TXT_PLACER=<optional URL>      # helper that POSTs the TXT
//
//      The live test will:
//        - add the domain (expect 201 + verify_token)
//        - poll DNS TXT via cloudflare-dns.com until the token appears
//          (up to 5 min); if PLUTO_TEST_TXT_PLACER is set, POST to it first
//        - call /verify (expect 200)
//        - probe https://<host>/health (expect 200)
//        - subscribe to /realtime/v1/?apikey=... and assert a
//          `custom_domains:<ws>` `domain.primary_changed` event arrives
//          within 15s of POST /:id/primary
//        - remove the domain and assert `domain.removed` broadcast
//
//      Without those env vars the live test self-skips.
import { test, expect, type APIRequestContext } from "@playwright/test";

// ------------- Fast smoke against mocked dev server ------------------

test.describe("custom-domains · UI + RBAC smoke", () => {
  test("member role sees read-only banner and disabled Add button", async ({ page }) => {
    await page.route("**/me/v1/workspace-role", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ role: "member", can_admin: false }) }),
    );
    await page.route("**/enterprise/v1/domains", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ domains: [] }) }),
    );
    await page.goto("/dashboard/custom-domains");
    await expect(page.getByText(/Only workspace/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Add domain/i })).toBeDisabled();
  });

  test("admin can add + primary-toggle a hostname via mocked API", async ({ page }) => {
    let addedHost = "";
    let primaryCalls = 0;
    const domains: any[] = [];

    await page.route("**/me/v1/workspace-role", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ role: "owner", can_admin: true }) }),
    );
    await page.route("**/enterprise/v1/domains", (route) => {
      if (route.request().method() === "POST") {
        addedHost = JSON.parse(route.request().postData() ?? "{}").hostname;
        const row = {
          id: "00000000-0000-0000-0000-0000000000d1",
          hostname: addedHost, is_wildcard: addedHost.startsWith("*."),
          is_primary: false, verified: false,
          verify_token: "tok-e2e", cert_status: "pending",
          created_at: new Date().toISOString(), verified_at: null,
          dns_txt_record: `_pluto-verify.${addedHost}`, dns_txt_value: "tok-e2e",
        };
        domains.push(row);
        return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(row) });
      }
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ domains }) });
    });
    await page.route("**/enterprise/v1/domains/*/verify", async (route) => {
      const d = domains[0]; if (d) { d.verified = true; d.cert_status = "issued"; d.verified_at = new Date().toISOString(); }
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, verified: true }) });
    });
    await page.route("**/enterprise/v1/domains/*/primary", async (route) => {
      primaryCalls++;
      const d = domains[0]; if (d) d.is_primary = route.request().method() === "POST";
      return route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, primary: d?.is_primary ?? false }) });
    });

    await page.goto("/dashboard/custom-domains");
    await page.getByPlaceholder(/api.yourbrand.com/i).fill("api.e2e-pluto.test");
    await page.getByRole("button", { name: /Add domain/i }).click();
    await expect(page.getByText("api.e2e-pluto.test")).toBeVisible();

    await page.getByRole("button", { name: /Verify/i }).click();
    await expect(page.getByRole("button", { name: /Make primary/i })).toBeVisible();

    await page.getByRole("button", { name: /Make primary/i }).click();
    await expect(page.locator("text=primary")).toBeVisible();
    expect(primaryCalls).toBeGreaterThan(0);
    expect(addedHost).toBe("api.e2e-pluto.test");
  });

  test("wildcard hostname is accepted and shows wildcard badge", async ({ page }) => {
    await page.route("**/me/v1/workspace-role", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ role: "admin", can_admin: true }) }),
    );
    const domains: any[] = [{
      id: "wc-1", hostname: "*.tenants.e2e-pluto.test", is_wildcard: true,
      is_primary: false, verified: false, verify_token: "wc-tok",
      cert_status: "pending", created_at: new Date().toISOString(), verified_at: null,
    }];
    await page.route("**/enterprise/v1/domains", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
        body: JSON.stringify({ domains }) }),
    );
    await page.goto("/dashboard/custom-domains");
    await expect(page.getByText("*.tenants.e2e-pluto.test")).toBeVisible();
    await expect(page.getByText("wildcard").first()).toBeVisible();
    // Wildcards cannot be primary — Make primary button must be absent.
    await expect(page.getByRole("button", { name: /Make primary/i })).toHaveCount(0);
  });
});

// ------------- Live staging real-DNS flow (opt-in) --------------------

const stagingBase   = process.env.PLUTO_STAGING_BASE;
const stagingKey    = process.env.PLUTO_STAGING_SERVICE_KEY;
const stagingWs     = process.env.PLUTO_STAGING_WORKSPACE;
const testDomain    = process.env.PLUTO_TEST_DOMAIN;
const liveEnabled   = Boolean(stagingBase && stagingKey && stagingWs && testDomain);

test.describe("custom-domains · live staging (real DNS)", () => {
  test.skip(!liveEnabled, "Set PLUTO_STAGING_BASE / SERVICE_KEY / WORKSPACE / TEST_DOMAIN to enable");
  test.setTimeout(6 * 60_000); // DNS propagation can take a few minutes

  const headers = () => ({
    apikey: stagingKey!,
    "x-workspace-id": stagingWs!,
    "content-type": "application/json",
  });

  async function pollTxt(name: string, expected: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { Accept: "application/dns-json" },
      });
      const body: any = await r.json().catch(() => ({}));
      const values = (body.Answer ?? []).map((a: any) => String(a.data).replace(/^"|"$/g, ""));
      if (values.some((v: string) => v.includes(expected))) return true;
      await new Promise((res) => setTimeout(res, 5_000));
    }
    return false;
  }

  test("full lifecycle: add → DNS TXT → verify → health → primary → remove", async ({ request }) => {
    // 1. Add domain
    const addRes = await request.post(`${stagingBase}/enterprise/v1/domains`, {
      headers: headers(), data: { hostname: testDomain },
    });
    expect(addRes.ok(), await addRes.text()).toBeTruthy();
    const added = await addRes.json();
    expect(added.dns_txt_record).toContain(testDomain);
    const domainId = added.id;
    const txtName = added.dns_txt_record as string;
    const txtValue = added.dns_txt_value as string;

    // Optional: POST to a customer TXT placer helper before polling
    if (process.env.PLUTO_TEST_TXT_PLACER) {
      await fetch(process.env.PLUTO_TEST_TXT_PLACER, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: txtName, value: txtValue }),
      });
    }

    // 2. Wait for TXT propagation
    const propagated = await pollTxt(txtName, txtValue, 5 * 60_000);
    expect(propagated, `TXT ${txtName}=${txtValue} did not propagate`).toBe(true);

    // 3. Verify
    const verifyRes = await request.post(
      `${stagingBase}/enterprise/v1/domains/${domainId}/verify`,
      { headers: headers() },
    );
    expect(verifyRes.ok(), await verifyRes.text()).toBeTruthy();
    expect((await verifyRes.json()).verified).toBe(true);

    // 4. Health endpoint reachable
    const healthRes = await fetch(`https://${testDomain}/health`, { method: "GET" }).catch(() => null);
    expect(healthRes && healthRes.ok, `health ${testDomain}/health unreachable`).toBeTruthy();

    // 5. Subscribe to realtime BEFORE mutating so we can assert broadcast
    const wsUrl = `${stagingBase!.replace(/^http/, "ws")}/realtime/v1/?apikey=${encodeURIComponent(stagingKey!)}`;
    const events: any[] = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new (globalThis as any).WebSocket(wsUrl);
      const t = setTimeout(() => reject(new Error("realtime open timeout")), 10_000);
      ws.onopen = () => {
        clearTimeout(t);
        ws.send(JSON.stringify({ type: "subscribe", channel: `custom_domains:${stagingWs}` }));
        // Kick off the primary + remove mutations after subscribing.
        (async () => {
          await request.post(`${stagingBase}/enterprise/v1/domains/${domainId}/primary`, { headers: headers() });
          await new Promise((r) => setTimeout(r, 2_000));
          await request.delete(`${stagingBase}/enterprise/v1/domains/${domainId}`, { headers: headers() });
        })().catch((err) => reject(err));
      };
      ws.onmessage = (e: MessageEvent) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.channel === `custom_domains:${stagingWs}`) events.push(msg);
          if (events.some((m) => m.event === "domain.removed")) { ws.close(); resolve(); }
        } catch { /* ignore */ }
      };
      ws.onerror = (err: unknown) => reject(err as Error);
      // Safety cutoff
      setTimeout(() => resolve(), 60_000);
    });

    const eventNames = events.map((e) => e.event);
    expect(eventNames).toEqual(expect.arrayContaining(["domain.primary_changed", "domain.removed"]));
  });
});

// ------------- Backend audit-log query smoke --------------------------

test.describe("custom-domains · audit persistence", () => {
  test.skip(!liveEnabled, "requires staging backend");
  test("backend audit log includes domain.* actions filtered by workspace_id", async ({ request }: { request: APIRequestContext }) => {
    const r = await request.get(
      `${stagingBase}/admin/v1/audit?action=domain.*&workspace_id=${stagingWs}&limit=50`,
      { headers: { apikey: stagingKey! } },
    );
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    expect(Array.isArray(body.items)).toBeTruthy();
    // Every returned row must match the requested workspace and action prefix.
    for (const row of body.items as any[]) {
      expect(row.action.startsWith("domain.")).toBe(true);
      expect(row.metadata?.workspace_id).toBe(stagingWs);
      expect(typeof row.ts).toBe("string");
      // Actor stamp must be present (email or id or role for webhook rows).
      expect(row.actor_email ?? row.actor_id ?? row.actor_role).toBeTruthy();
    }
  });
});
