/**
 * Connect-wizard domain logic: live checks, diagnostics rules, .env bundle
 * generation and verification-report serialisation.
 *
 * Pure browser code — every probe is a plain fetch against the tenant's
 * apiBase so it exercises the same path the customer's app will use
 * (including CORS preflight behaviour).
 */

export type CheckId =
  | "health"
  | "keys"
  | "cors"
  | "auth"
  | "rls"
  | "import"
  | "storage"
  | "realtime";

export type CheckStatus = "idle" | "running" | "pass" | "warn" | "fail" | "skipped";

export type Evidence = {
  url: string;
  method: string;
  status: number;
  latencyMs: number;
  bodyPreview?: string;
  error?: string;
};

export type CheckResult = {
  id: CheckId;
  label: string;
  label_bn: string;
  status: CheckStatus;
  detail: string;
  latencyMs?: number;
  /** Diagnostic hints resolved from the failure signature. */
  hints?: Diagnosis[];
  /** Raw request/response snippet for the report + debugging. */
  evidence?: Evidence;
};

export type Diagnosis = {
  cause: string;
  cause_bn: string;
  fix: string;
  fix_bn: string;
  link?: string;
};

export type WizardConfig = {
  apiBase: string;
  anonKey: string;
  serviceKey: string;
  appOrigin: string;
  projectRef: string;
  table: string;
  bucket: string;
};

export const CHECK_LABELS: Record<CheckId, { en: string; bn: string }> = {
  health: { en: "Backend reachable", bn: "ব্যাকএন্ড রিচেবল" },
  keys: { en: "API keys valid", bn: "API key বৈধ" },
  cors: { en: "CORS allows your origin", bn: "CORS origin অনুমোদিত" },
  auth: { en: "Auth service online", bn: "Auth সার্ভিস সচল" },
  rls: { en: "RBAC / RLS enforced", bn: "RBAC / RLS কার্যকর" },
  import: { en: "Imported data readable", bn: "ইমপোর্ট করা ডেটা পঠনযোগ্য" },
  storage: { en: "Storage buckets", bn: "স্টোরেজ বাকেট" },
  realtime: { en: "Realtime endpoint", bn: "রিয়েলটাইম এন্ডপয়েন্ট" },
};

/* ------------------------------------------------------------------ *
 * Diagnostics rule table — matched against the raw error signature.
 * ------------------------------------------------------------------ */

const RULES: { match: RegExp; d: Diagnosis }[] = [
  {
    match: /failed to fetch|networkerror|load failed|typeerror: fetch/i,
    d: {
      cause: "Browser blocked the request — almost always CORS, or the API host is unreachable / not on HTTPS.",
      cause_bn: "ব্রাউজার রিকোয়েস্ট ব্লক করেছে — সাধারণত CORS, অথবা API host অচল বা HTTPS নয়।",
      fix: "Add this exact origin (scheme + host + port, no trailing slash) to the CORS whitelist, then hard-refresh.",
      fix_bn: "এই হুবহু origin (scheme + host + port, শেষে slash ছাড়া) CORS whitelist-এ যোগ করে hard-refresh দিন।",
      link: "/dashboard/cors",
    },
  },
  {
    match: /\b401\b|unauthorized|invalid api key|invalid_key|jwt/i,
    d: {
      cause: "The anon key is missing, expired, revoked, or belongs to another project.",
      cause_bn: "anon key নেই, মেয়াদোত্তীর্ণ, বাতিল, অথবা অন্য প্রজেক্টের।",
      fix: "Regenerate the anon key under Projects & Keys and paste the fresh value into VITE_PLUTO_ANON_KEY.",
      fix_bn: "Projects & Keys থেকে নতুন anon key তৈরি করে VITE_PLUTO_ANON_KEY-তে বসান।",
      link: "/dashboard/api",
    },
  },
  {
    match: /\b403\b|forbidden|permission denied|rls|row-level/i,
    d: {
      cause: "Row Level Security denied the read — either no policy exists, or the anon role is not granted.",
      cause_bn: "RLS রিড আটকে দিয়েছে — হয় policy নেই, নয়তো anon role-এ grant দেওয়া হয়নি।",
      fix: "Add a SELECT policy for the intended role and GRANT SELECT on the table. A 403 here is expected (and healthy) for private tables.",
      fix_bn: "উদ্দিষ্ট role-এর জন্য SELECT policy যোগ করুন ও টেবিলে GRANT SELECT দিন। প্রাইভেট টেবিলে 403 আসাই স্বাভাবিক।",
      link: "/dashboard/rbac",
    },
  },
  {
    match: /\b404\b|not found|undefined table|does not exist|42p01/i,
    d: {
      cause: "The table/route does not exist on this project — the import may not have been applied.",
      cause_bn: "এই প্রজেক্টে টেবিল/রুটটি নেই — সম্ভবত ইমপোর্ট apply হয়নি।",
      fix: "Run the import again and confirm the Apply step finished, then re-check the schema.",
      fix_bn: "ইমপোর্ট আবার চালিয়ে Apply ধাপ শেষ হয়েছে কিনা নিশ্চিত করে schema আবার দেখুন।",
      link: "/dashboard/database-import",
    },
  },
  {
    match: /\b5\d\d\b|internal server error|bad gateway|gateway timeout/i,
    d: {
      cause: "The backend answered with a server error — service down, migration mid-flight, or DB unreachable.",
      cause_bn: "ব্যাকএন্ড server error দিয়েছে — সার্ভিস বন্ধ, migration চলছে, বা DB unreachable।",
      fix: "Check Backend status and the Ops migration log; restart the API service if it is stuck.",
      fix_bn: "Backend status ও Ops migration log দেখুন; আটকে থাকলে API সার্ভিস restart করুন।",
      link: "/dashboard/backend-status",
    },
  },
  {
    match: /timeout|aborted|signal/i,
    d: {
      cause: "The request timed out before the backend responded.",
      cause_bn: "ব্যাকএন্ড উত্তর দেওয়ার আগেই রিকোয়েস্ট timeout হয়েছে।",
      fix: "Verify DNS/SSL for the API domain and that the VPS is not overloaded.",
      fix_bn: "API ডোমেইনের DNS/SSL ঠিক আছে কিনা এবং VPS overload নয় তা যাচাই করুন।",
      link: "/dashboard/custom-domains",
    },
  },
];

export function diagnose(signature: string): Diagnosis[] {
  const out = RULES.filter((r) => r.match.test(signature)).map((r) => r.d);
  return out.length
    ? out
    : [
        {
          cause: "Unrecognised failure signature.",
          cause_bn: "অজানা ত্রুটি।",
          fix: "Open the raw response below and cross-check against Logs Explorer for the same timestamp.",
          fix_bn: "নিচের raw response দেখুন এবং একই সময়ের জন্য Logs Explorer মিলিয়ে দেখুন।",
          link: "/dashboard/logs-explorer",
        },
      ];
}

/* ------------------------------------------------------------------ *
 * Probes
 * ------------------------------------------------------------------ */

type Probe = {
  ok: boolean;
  status: number;
  body: string;
  ms: number;
  error?: string;
  url: string;
  method: string;
};

async function req(url: string, init?: RequestInit): Promise<Probe> {
  const started = Date.now();
  const method = (init?.method ?? "GET").toUpperCase();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(12_000) });
    const body = (await res.text()).slice(0, 600);
    return { ok: res.ok, status: res.status, body, ms: Date.now() - started, url, method };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: "",
      ms: Date.now() - started,
      url,
      method,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function evidenceOf(p: Probe): Evidence {
  return {
    url: p.url,
    method: p.method,
    status: p.status,
    latencyMs: p.ms,
    bodyPreview: p.body ? p.body.slice(0, 400) : undefined,
    error: p.error,
  };
}

function base(cfg: WizardConfig): string {
  return cfg.apiBase.replace(/\/+$/, "");
}

function keyHeaders(cfg: WizardConfig): Record<string, string> {
  return cfg.anonKey
    ? { apikey: cfg.anonKey, authorization: `Bearer ${cfg.anonKey}`, accept: "application/json" }
    : { accept: "application/json" };
}

function result(
  id: CheckId,
  status: CheckStatus,
  detail: string,
  latencyMs?: number,
  signature?: string,
  probe?: Probe,
): CheckResult {
  return {
    id,
    label: CHECK_LABELS[id].en,
    label_bn: CHECK_LABELS[id].bn,
    status,
    detail,
    latencyMs,
    hints: status === "fail" || status === "warn" ? diagnose(signature ?? detail) : undefined,
    evidence: probe ? evidenceOf(probe) : undefined,
  };
}

export async function runCheck(id: CheckId, cfg: WizardConfig): Promise<CheckResult> {
  const b = base(cfg);
  switch (id) {
    case "health": {
      const p = await req(`${b}/v1/health`, { headers: { accept: "application/json" } });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      return result(id, p.ok ? "pass" : "fail", p.ok ? `HTTP 200 · ${p.ms}ms` : sig, p.ms, sig);
    }
    case "keys": {
      if (!cfg.anonKey) return result(id, "warn", "No anon key entered yet.", 0, "invalid api key");
      const p = await req(`${b}/auth/v1/settings`, { headers: keyHeaders(cfg) });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      if (p.status === 401 || p.status === 403) return result(id, "fail", sig, p.ms, sig);
      return result(id, p.ok || p.status === 404 ? "pass" : "warn", p.ok ? `Key accepted · ${p.ms}ms` : sig, p.ms, sig);
    }
    case "cors": {
      const p = await req(`${b}/v1/health`, { method: "GET", headers: { accept: "application/json" } });
      if (p.error) {
        return result(id, "fail", `Blocked from ${cfg.appOrigin}: ${p.error}`, p.ms, `failed to fetch ${p.error}`);
      }
      return result(id, "pass", `${cfg.appOrigin} → allowed · ${p.ms}ms`, p.ms);
    }
    case "auth": {
      const p = await req(`${b}/auth/v1/health`, { headers: keyHeaders(cfg) });
      const alt = p.status === 404 ? await req(`${b}/auth/v1/settings`, { headers: keyHeaders(cfg) }) : p;
      const sig = alt.error ?? `HTTP ${alt.status} ${alt.body}`;
      return result(id, alt.ok ? "pass" : "fail", alt.ok ? `Auth online · ${alt.ms}ms` : sig, alt.ms, sig);
    }
    case "rls": {
      const table = cfg.table || "todos";
      const p = await req(`${b}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
        headers: keyHeaders(cfg),
      });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      if (p.status === 401 || p.status === 403) {
        return result(id, "pass", `RLS actively denies anon on "${table}" (HTTP ${p.status}) — protected.`, p.ms);
      }
      if (p.ok) {
        return result(id, "warn", `"${table}" is readable by anon — confirm this is intentional.`, p.ms, "row-level security open");
      }
      return result(id, "fail", sig, p.ms, sig);
    }
    case "import": {
      const table = cfg.table || "todos";
      const p = await req(`${b}/rest/v1/${encodeURIComponent(table)}?select=*&limit=1`, {
        headers: cfg.serviceKey
          ? { apikey: cfg.serviceKey, authorization: `Bearer ${cfg.serviceKey}`, accept: "application/json" }
          : keyHeaders(cfg),
      });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      if (p.ok) return result(id, "pass", `Table "${table}" exists and returns rows · ${p.ms}ms`, p.ms);
      const missing = p.status === 404 || /42p01|does not exist/i.test(p.body);
      if (missing) return result(id, "fail", `Table "${table}" not found — import not applied?`, p.ms, sig);
      return result(id, "warn", sig, p.ms, sig);
    }
    case "storage": {
      const p = await req(`${b}/storage/v1/bucket`, { headers: keyHeaders(cfg) });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      return result(id, p.ok ? "pass" : "warn", p.ok ? `Buckets listed · ${p.ms}ms` : sig, p.ms, sig);
    }
    case "realtime": {
      const p = await req(`${b}/realtime/v1/health`, { headers: keyHeaders(cfg) });
      const sig = p.error ?? `HTTP ${p.status} ${p.body}`;
      return result(id, p.ok ? "pass" : "warn", p.ok ? `Realtime up · ${p.ms}ms` : sig, p.ms, sig);
    }
  }
}

export const ALL_CHECKS: CheckId[] = [
  "health",
  "keys",
  "cors",
  "auth",
  "rls",
  "import",
  "storage",
  "realtime",
];

/* ------------------------------------------------------------------ *
 * .env bundle + README
 * ------------------------------------------------------------------ */

export function buildEnvFile(cfg: WizardConfig): string {
  return `# ─────────────────────────────────────────────────────────────
# Pluto BaaS — frontend environment
# Generated ${new Date().toISOString()}
# Safe to commit? NO — keep this file out of git.
# ─────────────────────────────────────────────────────────────

# Public API base URL
VITE_PLUTO_URL=${cfg.apiBase}
NEXT_PUBLIC_PLUTO_URL=${cfg.apiBase}

# Public (anon) key — protected by RLS, safe in browser bundles
VITE_PLUTO_ANON_KEY=${cfg.anonKey || "pk_anon_REPLACE_ME"}
NEXT_PUBLIC_PLUTO_ANON_KEY=${cfg.anonKey || "pk_anon_REPLACE_ME"}

# Project reference
VITE_PLUTO_PROJECT_REF=${cfg.projectRef || "your-project-ref"}

# ── SERVER ONLY — never expose to the browser ──
PLUTO_URL=${cfg.apiBase}
PLUTO_SERVICE_ROLE_KEY=${cfg.serviceKey || "sk_service_REPLACE_ME"}

# Direct Postgres connection (server-side scripts, Prisma, migrations)
DATABASE_URL=postgresql://postgres:PASSWORD@db.host:5432/postgres?sslmode=require
`;
}

export function buildReadme(cfg: WizardConfig): string {
  return `# Connecting this project to Pluto BaaS

Generated ${new Date().toISOString()} from the Connect Project wizard.

## 1. Environment

Copy \`.env\` (bundled alongside this file) into your project root.
Never ship \`PLUTO_SERVICE_ROLE_KEY\` or \`DATABASE_URL\` to the browser.

## 2. Install

\`\`\`bash
bun add @pluto/js     # or: npm install @pluto/js
\`\`\`

## 3. Client

\`\`\`ts
// src/lib/pluto.ts
import { createClient } from "@pluto/js";

export const pluto = createClient(
  import.meta.env.VITE_PLUTO_URL,
  import.meta.env.VITE_PLUTO_ANON_KEY,
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: "pluto.auth.token" } },
);
\`\`\`

## 4. CORS

Add exactly this origin to the whitelist (scheme + host + port, no trailing slash):

    ${cfg.appOrigin}

## 5. Row Level Security

Every user-facing table must have RLS enabled plus explicit policies:

\`\`\`sql
alter table public.${cfg.table || "todos"} enable row level security;

create policy "owner reads"  on public.${cfg.table || "todos"}
  for select using (auth.uid() = user_id);
create policy "owner writes" on public.${cfg.table || "todos"}
  for insert with check (auth.uid() = user_id);

grant select, insert, update, delete on public.${cfg.table || "todos"} to authenticated;
\`\`\`

## 6. Verify

Re-run the wizard's "Run all checks" and export the verification report
(JSON) for your deploy record.

## Endpoints

| Purpose  | URL |
|----------|-----|
| REST     | ${cfg.apiBase}/rest/v1 |
| Auth     | ${cfg.apiBase}/auth/v1 |
| Storage  | ${cfg.apiBase}/storage/v1 |
| Realtime | ${cfg.apiBase.replace(/^http/, "ws")}/realtime/v1 |
| Functions| ${cfg.apiBase}/functions/v1 |
`;
}

export type VerificationReport = {
  generatedAt: string;
  apiBase: string;
  appOrigin: string;
  projectRef: string;
  table: string;
  summary: { total: number; pass: number; warn: number; fail: number; skipped: number };
  overall: "pass" | "warn" | "fail";
  checks: CheckResult[];
};

export function buildReport(cfg: WizardConfig, checks: CheckResult[]): VerificationReport {
  const count = (s: CheckStatus) => checks.filter((c) => c.status === s).length;
  const fail = count("fail");
  const warn = count("warn");
  return {
    generatedAt: new Date().toISOString(),
    apiBase: cfg.apiBase,
    appOrigin: cfg.appOrigin,
    projectRef: cfg.projectRef,
    table: cfg.table,
    summary: {
      total: checks.length,
      pass: count("pass"),
      warn,
      fail,
      skipped: count("skipped"),
    },
    overall: fail > 0 ? "fail" : warn > 0 ? "warn" : "pass",
    checks,
  };
}

export function reportToMarkdown(r: VerificationReport): string {
  const icon = (s: CheckStatus) =>
    s === "pass" ? "✅" : s === "warn" ? "⚠️" : s === "fail" ? "❌" : "•";
  const rows = r.checks
    .map((c) => `| ${icon(c.status)} | ${c.label} | ${c.status} | ${c.detail.replace(/\|/g, "\\|")} |`)
    .join("\n");
  const hints = r.checks
    .filter((c) => c.hints?.length && c.status !== "pass")
    .map(
      (c) =>
        `### ${c.label}\n` +
        c.hints!.map((h) => `- **Cause:** ${h.cause}\n  **Fix:** ${h.fix}`).join("\n"),
    )
    .join("\n\n");
  return `# Pluto connection verification report

- Generated: ${r.generatedAt}
- API base: ${r.apiBase}
- App origin: ${r.appOrigin}
- Overall: **${r.overall.toUpperCase()}** (${r.summary.pass} pass / ${r.summary.warn} warn / ${r.summary.fail} fail)

| | Check | Status | Detail |
|---|---|---|---|
${rows}

${hints ? `## Suggested fixes\n\n${hints}\n` : ""}`;
}

export function downloadText(filename: string, content: string, mime = "text/plain") {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
