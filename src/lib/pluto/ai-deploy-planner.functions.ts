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
