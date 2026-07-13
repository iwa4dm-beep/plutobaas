// AI-driven deploy planner + VPS/DNS guide generator.
//
// Two server functions:
//  - planDeploy: takes lightweight bundle+workspace context, asks Lovable AI
//    Gateway to produce a strict-JSON Deploy Plan (pre-deploy SQL suggestions,
//    infra checks, ordered steps, risks).
//  - generateVpsGuide: takes plan + domain + optional VPS IP → produces a
//    step-by-step Bash script + human-readable checklist for installing the
//    sandbox-worker and pointing DNS/TLS at app.<domain>.
//
// Both fall back to deterministic heuristics if LOVABLE_API_KEY is missing
// so the UI keeps working offline.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const MODEL = "google/gemini-2.5-flash";
const GATEWAY = "https://ai.gateway.lovable.dev/v1/chat/completions";

export type DeployStep = {
  id: string;
  title: string;
  detail: string;
  kind: "sql" | "infra" | "upload" | "verify" | "activate" | "dns" | "tls" | "post";
  risk: "low" | "med" | "high";
};

export type DeployPlan = {
  summary: string;
  steps: DeployStep[];
  preSql: string;
  risks: { severity: "low" | "med" | "high"; message: string }[];
  postChecks: string[];
  model: string;
};

const PlanInput = z.object({
  workspaceId: z.string().min(2),
  bundleName: z.string().optional(),
  bundleSizeKb: z.number().optional(),
  hasMigrations: z.boolean().optional(),
  domain: z.string().optional(),
  notes: z.string().optional(),
});

export const planDeploy = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PlanInput.parse(raw))
  .handler(async ({ data }): Promise<DeployPlan> => {
    const key = process.env.LOVABLE_API_KEY;
    const fallback = heuristicPlan(data);
    if (!key) return fallback;

    const prompt = `You are Pluto BaaS deploy planner. Given this deploy context, output STRICT JSON matching:
{
  "summary": "1-2 sentence deploy overview",
  "steps": [{"id":"...","title":"...","detail":"...","kind":"sql|infra|upload|verify|activate|dns|tls|post","risk":"low|med|high"}],
  "preSql": "-- optional idempotent pre-deploy SQL (use IF NOT EXISTS)",
  "risks": [{"severity":"low|med|high","message":"..."}],
  "postChecks": ["human check 1","human check 2"]
}
Rules:
- ONLY JSON, no markdown fences.
- 5-8 steps ordered pre-deploy → deploy → post.
- Include dns/tls steps only if a domain is provided.
- preSql must be safe & idempotent; empty string if nothing needed.

CONTEXT:
${JSON.stringify(data, null, 2)}`;

    try {
      const r = await fetch(GATEWAY, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Lovable-API-Key": key,
          "X-Lovable-AIG-SDK": "pluto-baas",
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: "user", content: prompt }],
          response_format: { type: "json_object" },
        }),
      });
      if (!r.ok) return { ...fallback, model: `heuristic (gateway ${r.status})` };
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
      const raw = j.choices?.[0]?.message?.content ?? "";
      const parsed = safeParse(raw);
      if (!parsed) return { ...fallback, model: "heuristic (parse-fail)" };
      return { ...fallback, ...parsed, model: MODEL };
    } catch (e) {
      return { ...fallback, model: `heuristic (err: ${(e as Error).message.slice(0, 60)})` };
    }
  });

const GuideInput = z.object({
  domain: z.string().min(3),
  vpsIp: z.string().optional(),
  workspaceId: z.string().min(2),
  repoUrl: z.string().optional().default("https://github.com/your-org/pluto-baas.git"),
  email: z.string().email().optional(),
});

export type VpsGuide = {
  script: string;
  checklist: { step: number; title: string; command?: string; note?: string }[];
  dnsRecords: { type: "A" | "TXT"; name: string; value: string; note: string }[];
  model: string;
};

export const generateVpsGuide = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => GuideInput.parse(raw))
  .handler(async ({ data }): Promise<VpsGuide> => {
    // Deterministic script — reliable and copy-pasteable. AI is only used to
    // annotate the checklist with plain-language notes.
    const subdomain = `app.${data.domain}`.replace(/^app\.app\./, "app.");
    const ip = data.vpsIp ?? "<YOUR_VPS_PUBLIC_IP>";
    const email = data.email ?? "admin@" + data.domain;

    const script = `#!/usr/bin/env bash
# Pluto BaaS — one-shot VPS bootstrap for ${subdomain}
# Run as root on a fresh Ubuntu 22.04/24.04 VPS.
set -euo pipefail

DOMAIN="${subdomain}"
WORKSPACE_ID="${data.workspaceId}"
REPO_URL="${data.repoUrl}"
LE_EMAIL="${email}"

echo "==> 1. System deps"
apt-get update -y
apt-get install -y curl git nginx certbot python3-certbot-nginx ufw
if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> 2. Clone/refresh repo"
if [ ! -d /opt/pluto-baas ]; then
  git clone "$REPO_URL" /opt/pluto-baas
else
  git -C /opt/pluto-baas pull --ff-only || true
fi
WORKER_DIR="$(find /opt/pluto-baas -type d -name sandbox-worker | head -n1)"
if [ -z "$WORKER_DIR" ]; then echo "sandbox-worker/ not found in repo"; exit 1; fi
echo "worker dir: $WORKER_DIR"

echo "==> 3. Install sandbox-worker (systemd + shared secret)"
cd "$WORKER_DIR"
# Skip the strict :80/:443 conflict check — worker listens on 127.0.0.1:8787.
SKIP_PORT_CHECK=1 bash install.sh || true

echo "==> 4. Nginx site for $DOMAIN"
install -m 0644 nginx-app.conf /etc/nginx/sites-available/pluto-app.conf
sed -i "s|<WORKSPACE_ID>|$WORKSPACE_ID|g; s|<DOMAIN>|$DOMAIN|g" /etc/nginx/sites-available/pluto-app.conf
ln -sf /etc/nginx/sites-available/pluto-app.conf /etc/nginx/sites-enabled/pluto-app.conf
nginx -t && systemctl reload nginx

echo "==> 5. Firewall"
ufw allow 'Nginx Full' || true
ufw allow OpenSSH || true
yes | ufw enable || true

echo "==> 6. TLS via Let's Encrypt"
echo "   (requires an A record for $DOMAIN → ${ip} to be live)"
if dig +short "$DOMAIN" | grep -q .; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$LE_EMAIL" --redirect
else
  echo "!! DNS for $DOMAIN not resolvable yet — add the A record and re-run:"
  echo "   sudo certbot --nginx -d $DOMAIN -m $LE_EMAIL --agree-tos --redirect"
fi

echo "==> 7. Health check"
systemctl status pluto-sandbox --no-pager | head -n 15 || true
curl -sS http://127.0.0.1:8787/health || true
echo
echo "Done. Set the following in Lovable Cloud Secrets:"
echo "  PLUTO_SANDBOX_URL=https://$DOMAIN"
echo "  PLUTO_SANDBOX_SECRET=<value from /etc/pluto-sandbox/env>"
`;

    const checklist: VpsGuide["checklist"] = [
      { step: 1, title: "Add DNS A record", note: `In your DNS provider, add A record: ${subdomain} → ${ip}. Wait until 'dig +short ${subdomain}' returns the IP.` },
      { step: 2, title: "SSH to VPS as root", command: `ssh root@${ip}` },
      { step: 3, title: "Save & run the script", command: `nano /root/pluto-deploy.sh   # paste script, save\nsudo bash /root/pluto-deploy.sh` },
      { step: 4, title: "Copy sandbox secret", command: `sudo cat /etc/pluto-sandbox/env | grep SECRET`, note: "Copy the SECRET value." },
      { step: 5, title: "Add secrets in Lovable Cloud", note: `Add PLUTO_SANDBOX_URL=https://${subdomain} and PLUTO_SANDBOX_SECRET=<the value above>.` },
      { step: 6, title: "Re-run deploy from Pluto UI", note: "Trigger 'Run full deploy' again — unpack-serve step should now flip live." },
      { step: 7, title: "Verify", command: `curl -I https://${subdomain}/`, note: "Expect HTTP 200 and served frontend." },
    ];

    const dnsRecords: VpsGuide["dnsRecords"] = [
      { type: "A", name: "app", value: ip, note: `Points ${subdomain} at your VPS. Required for TLS issuance.` },
    ];

    return { script, checklist, dnsRecords, model: "deterministic-v1" };
  });

// ── Uninstall / rollback script ────────────────────────────────────────────
const UninstallInput = z.object({
  domain: z.string().min(3),
  keepCerts: z.boolean().optional().default(false),
});

export const generateUninstallScript = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => UninstallInput.parse(raw))
  .handler(async ({ data }): Promise<{ script: string }> => {
    const subdomain = `app.${data.domain}`.replace(/^app\.app\./, "app.");
    const script = `#!/usr/bin/env bash
# Pluto BaaS — rollback / uninstall for ${subdomain}
# Restores previous state: stops sandbox-worker, removes nginx site, ${data.keepCerts ? "keeps" : "revokes"} TLS certs.
set -uo pipefail
DOMAIN="${subdomain}"

echo "==> 1. Stop & disable sandbox-worker"
systemctl stop  pluto-sandbox 2>/dev/null || true
systemctl disable pluto-sandbox 2>/dev/null || true
rm -f /etc/systemd/system/pluto-sandbox.service
systemctl daemon-reload || true

echo "==> 2. Remove nginx site"
rm -f /etc/nginx/sites-enabled/pluto-app.conf
rm -f /etc/nginx/sites-available/pluto-app.conf
nginx -t && systemctl reload nginx || true

${data.keepCerts ? `echo "==> 3. Keep TLS cert for $DOMAIN (skipped revoke)"` : `echo "==> 3. Revoke & delete cert for $DOMAIN"
certbot revoke --cert-name "$DOMAIN" --non-interactive || true
certbot delete --cert-name "$DOMAIN" --non-interactive || true`}

echo "==> 4. Remove worker files"
rm -rf /opt/pluto-sandbox /etc/pluto-sandbox
# Repo checkout at /opt/pluto-baas is left intact — remove manually if desired.

echo "==> 5. Verify"
systemctl status pluto-sandbox --no-pager 2>&1 | head -n 3 || true
curl -sS -o /dev/null -w "nginx: HTTP %{http_code}\\n" "https://$DOMAIN/" || true
echo "Done. Rollback complete."
`;
    return { script };
  });

// ── Preflight checks ───────────────────────────────────────────────────────
const PreflightInput = z.object({
  workspaceId: z.string().min(2),
  domain: z.string().optional(),
  bundleName: z.string().optional(),
});

export type PreflightCheck = { name: string; ok: boolean; detail: string; kind: "secret" | "input" | "network" };

export const runPreflight = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PreflightInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean; checks: PreflightCheck[] }> => {
    const checks: PreflightCheck[] = [];

    // Input validations
    checks.push({
      name: "Workspace ID format",
      ok: /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,127}$/.test(data.workspaceId),
      detail: data.workspaceId ? `"${data.workspaceId}"` : "empty",
      kind: "input",
    });
    checks.push({
      name: "Bundle selected",
      ok: !!data.bundleName,
      detail: data.bundleName ?? "no bundle uploaded",
      kind: "input",
    });
    if (data.domain) {
      checks.push({
        name: "Domain format",
        ok: /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(data.domain),
        detail: data.domain,
        kind: "input",
      });
    }

    // Secret presence
    const secrets = ["LOVABLE_API_KEY", "PLUTO_SERVICE_ROLE_KEY", "PLUTO_SANDBOX_URL", "PLUTO_SANDBOX_SECRET"] as const;
    for (const s of secrets) {
      const present = !!process.env[s];
      checks.push({
        name: `Secret ${s}`,
        ok: present || s === "PLUTO_SANDBOX_URL" || s === "PLUTO_SANDBOX_SECRET" ? present : false,
        detail: present ? "configured" : (s.startsWith("PLUTO_SANDBOX") ? "missing — required for live serve" : "missing"),
        kind: "secret",
      });
    }

    // Sandbox reachability
    const sandboxUrl = process.env.PLUTO_SANDBOX_URL;
    if (sandboxUrl) {
      const started = Date.now();
      try {
        const r = await fetch(sandboxUrl.replace(/\/$/, "") + "/health", { method: "GET" });
        checks.push({
          name: "Sandbox /health reachable",
          ok: r.ok,
          detail: `HTTP ${r.status} · ${Date.now() - started}ms`,
          kind: "network",
        });
      } catch (e) {
        checks.push({ name: "Sandbox /health reachable", ok: false, detail: (e as Error).message, kind: "network" });
      }
    } else {
      checks.push({ name: "Sandbox /health reachable", ok: false, detail: "PLUTO_SANDBOX_URL not set — cannot probe", kind: "network" });
    }

    const ok = checks.filter((c) => c.kind !== "secret" || c.name.includes("SANDBOX")).every((c) => c.ok);
    return { ok, checks };
  });

// ── Post-install health checks (against a running VPS) ─────────────────────
const PostInstallInput = z.object({
  domain: z.string().min(3),
});

export type HealthProbe = { name: string; ok: boolean; detail: string };

export const checkPostInstallHealth = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PostInstallInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean; probes: HealthProbe[] }> => {
    const subdomain = `app.${data.domain}`.replace(/^app\.app\./, "app.");
    const probes: HealthProbe[] = [];

    // 1. HTTPS reachable (nginx up + certbot success)
    async function probe(name: string, url: string): Promise<HealthProbe> {
      const started = Date.now();
      try {
        const r = await fetch(url, { method: "GET", redirect: "manual" });
        return { name, ok: r.status < 500, detail: `HTTP ${r.status} · ${Date.now() - started}ms` };
      } catch (e) {
        return { name, ok: false, detail: (e as Error).message };
      }
    }
    probes.push(await probe(`https://${subdomain}/ (nginx + TLS)`, `https://${subdomain}/`));
    probes.push(await probe(`https://${subdomain}/health (backend)`, `https://${subdomain}/health`));
    probes.push(await probe(`http://${subdomain}/ (redirect → https)`, `http://${subdomain}/`));

    return { ok: probes.every((p) => p.ok), probes };
  });

// ── Port 80 / 443 reachability probe (pre-Certbot) ─────────────────────────
const PortsInput = z.object({ domain: z.string().min(3) });

export type PortProbe = { port: 80 | 443; ok: boolean; detail: string };

export const checkPortsReachable = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PortsInput.parse(raw))
  .handler(async ({ data }): Promise<{ ok: boolean; probes: PortProbe[]; tips: string[] }> => {
    const host = `app.${data.domain}`.replace(/^app\.app\./, "app.");
    const probes: PortProbe[] = [];

    async function probe(port: 80 | 443): Promise<PortProbe> {
      const url = `${port === 443 ? "https" : "http"}://${host}/`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const started = Date.now();
      try {
        const r = await fetch(url, { method: "HEAD", redirect: "manual", signal: ctrl.signal });
        return { port, ok: true, detail: `HTTP ${r.status} · ${Date.now() - started}ms` };
      } catch (e) {
        return { port, ok: false, detail: (e as Error).message.slice(0, 120) };
      } finally { clearTimeout(t); }
    }

    probes.push(await probe(80));
    probes.push(await probe(443));

    const tips: string[] = [];
    const p80 = probes.find((p) => p.port === 80)!;
    const p443 = probes.find((p) => p.port === 443)!;
    if (!p80.ok) {
      tips.push(`Port 80 unreachable on ${host}. Certbot HTTP-01 challenge WILL fail.`);
      tips.push(`On VPS: sudo ufw allow 'Nginx Full' && sudo ufw allow 80,443/tcp`);
      tips.push(`Check nginx is listening: sudo ss -tlnp | grep -E ':80|:443'`);
      tips.push(`If behind Cloudflare — set DNS record to "DNS only" (grey cloud) until cert issues.`);
    }
    if (!p443.ok && p80.ok) {
      tips.push(`Port 80 open but 443 not — TLS cert not yet issued. Run: sudo certbot --nginx -d ${host}`);
    }
    if (!p80.ok && !p443.ok) {
      tips.push(`Neither port reachable — verify DNS A record for ${host} points at your VPS IP (dig +short ${host}).`);
      tips.push(`Verify VPS firewall/security group allows inbound 80 & 443.`);
    }
    return { ok: p80.ok && p443.ok, probes, tips };
  });

// ── Consolidated verification (health + ports + DNS hint) ──────────────────
export const runFullVerification = createServerFn({ method: "POST" })
  .inputValidator((raw: unknown) => PortsInput.parse(raw))
  .handler(async ({ data }) => {
    const host = `app.${data.domain}`.replace(/^app\.app\./, "app.");
    const probes: HealthProbe[] = [];

    async function probe(name: string, url: string, method: "GET" | "HEAD" = "GET"): Promise<HealthProbe> {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const started = Date.now();
      try {
        const r = await fetch(url, { method, redirect: "manual", signal: ctrl.signal });
        return { name, ok: r.status < 500, detail: `HTTP ${r.status} · ${Date.now() - started}ms` };
      } catch (e) {
        return { name, ok: false, detail: (e as Error).message.slice(0, 140) };
      } finally { clearTimeout(t); }
    }

    // DNS resolution via Cloudflare DoH
    let dnsDetail = "unresolved";
    let dnsOk = false;
    try {
      const r = await fetch(`https://1.1.1.1/dns-query?name=${host}&type=A`, { headers: { accept: "application/dns-json" } });
      const j = (await r.json()) as { Answer?: { data: string; type: number }[] };
      const ips = (j.Answer ?? []).filter((a) => a.type === 1).map((a) => a.data);
      dnsOk = ips.length > 0;
      dnsDetail = ips.length ? `A → ${ips.join(", ")}` : "no A record";
    } catch (e) { dnsDetail = (e as Error).message; }

    probes.push({ name: `DNS A record for ${host}`, ok: dnsOk, detail: dnsDetail });
    probes.push(await probe(`Port 80 reachable`, `http://${host}/`, "HEAD"));
    probes.push(await probe(`Port 443 / TLS`, `https://${host}/`, "HEAD"));
    probes.push(await probe(`Backend /health`, `https://${host}/health`));
    probes.push(await probe(`HTTP → HTTPS redirect`, `http://${host}/`));
    probes.push(await probe(`Nginx serves root`, `https://${host}/`));

    const ok = probes.every((p) => p.ok);
    return { ok, host, probes, checkedAt: new Date().toISOString() };
  });

// ── Check which required secrets are set (for wizard) ──────────────────────
export const checkRequiredSecrets = createServerFn({ method: "GET" })
  .handler(async (): Promise<{ secrets: { name: string; set: boolean; required: boolean; description: string }[] }> => {
    const list = [
      { name: "PLUTO_SANDBOX_URL", required: true, description: "Public HTTPS URL of the VPS sandbox-worker (e.g. https://app.timescar.cloud)" },
      { name: "PLUTO_SANDBOX_SECRET", required: true, description: "Shared secret from /etc/pluto-sandbox/env — authenticates unpack-serve calls" },
      { name: "PLUTO_SERVED_SITE_URL", required: false, description: "Optional override for the served-site link shown in the Result panel" },
    ];
    return {
      secrets: list.map((s) => ({ ...s, set: !!process.env[s.name] })),
    };
  });


// ── helpers ────────────────────────────────────────────────────────────────
function heuristicPlan(d: z.infer<typeof PlanInput>): DeployPlan {
  const hasDomain = !!d.domain;
  const steps: DeployStep[] = [
    { id: "s1", title: "Ensure infra", detail: "Create storage bucket & verify service key.", kind: "infra", risk: "low" },
    { id: "s2", title: "Push migrations", detail: d.hasMigrations ? "Apply pre-deploy SQL to Postgres." : "Skip (no SQL provided).", kind: "sql", risk: d.hasMigrations ? "med" : "low" },
    { id: "s3", title: "Upload bundle", detail: `Upload ${d.bundleName ?? "bundle.zip"} to workspace ${d.workspaceId}.`, kind: "upload", risk: "low" },
    { id: "s4", title: "Verify deploy", detail: "Confirm bundle checksum & manifest.", kind: "verify", risk: "low" },
    { id: "s5", title: "Activate service", detail: "Call sandbox-worker unpack + symlink flip.", kind: "activate", risk: "med" },
    { id: "s6", title: "Post-deploy health", detail: "Runtime + bootstrap probes must return 2xx.", kind: "post", risk: "low" },
  ];
  if (hasDomain) {
    steps.push({ id: "s7", title: "DNS + TLS", detail: `Ensure app.${d.domain} A record + Let's Encrypt cert.`, kind: "dns", risk: "med" });
  }
  return {
    summary: `Heuristic plan for workspace ${d.workspaceId}${hasDomain ? ` on ${d.domain}` : ""}.`,
    steps,
    preSql: d.hasMigrations ? "-- pre-deploy SQL from bundle\n" : "",
    risks: [
      ...(hasDomain ? [] : [{ severity: "low" as const, message: "No domain provided — DNS/TLS steps skipped." }]),
    ],
    postChecks: [
      "GET /health returns 200",
      "Served site loads without console errors",
    ],
    model: "heuristic",
  };
}

function safeParse(text: string): Partial<DeployPlan> | null {
  try {
    const trimmed = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
    const p = JSON.parse(trimmed) as Partial<DeployPlan>;
    if (!p.steps || !Array.isArray(p.steps)) return null;
    return p;
  } catch {
    return null;
  }
}
