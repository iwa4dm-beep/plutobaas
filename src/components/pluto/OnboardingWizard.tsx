import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  Check, ChevronRight, ChevronLeft, Copy, Cloud, Container,
  Rocket, Server, Sparkles, X,
} from "lucide-react";

export type Plan = "self-hosted" | "starter" | "business";
export type Target = "docker" | "fly" | "railway" | "render";

type Persisted = {
  plan: Plan;
  target: Target;
  projectName: string;
  region: string;
  step: number;
  ts: number;
};

const STORAGE_KEY = "pluto.onboarding.v1";

const PLAN_META: Record<Plan, { title: string; blurb: string; defaultTarget: Target; targets: Target[] }> = {
  "self-hosted": {
    title: "Self-Hosted",
    blurb: "Run Pluto on your own hardware or VPS. MIT licensed, unlimited scale.",
    defaultTarget: "docker",
    targets: ["docker", "fly", "railway", "render"],
  },
  starter: {
    title: "Cloud Starter",
    blurb: "Managed Pluto — 10k MAU, 10 GB Postgres, 500k Edge invocations/mo.",
    defaultTarget: "fly",
    targets: ["fly", "railway"],
  },
  business: {
    title: "Business",
    blurb: "Production workloads — 100k MAU, read replicas, SSO, priority support.",
    defaultTarget: "render",
    targets: ["fly", "render"],
  },
};

const TARGET_META: Record<Target, { title: string; icon: typeof Cloud; hint: string; command: string; deployUrl: string }> = {
  docker:  { title: "Docker Compose", icon: Container, hint: "Any Linux host",       command: "docker compose up -d",  deployUrl: "http://localhost:3000" },
  fly:     { title: "Fly.io",         icon: Rocket,    hint: "Global edge",          command: "flyctl deploy",         deployUrl: "https://YOUR-APP.fly.dev" },
  railway: { title: "Railway",        icon: Cloud,     hint: "1-click template",     command: "railway up",            deployUrl: "https://YOUR-APP.up.railway.app" },
  render:  { title: "Render",         icon: Server,    hint: "Blueprint via YAML",   command: "render blueprint launch", deployUrl: "https://YOUR-APP.onrender.com" },
};

const REGIONS = ["iad (Ashburn)", "sfo (San Jose)", "ams (Amsterdam)", "sin (Singapore)", "syd (Sydney)"];

function loadPersisted(): Partial<Persisted> {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Persisted>; }
  catch { return {}; }
}

function savePersisted(p: Persisted) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch { /* quota etc. */ }
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "my-app";
}

function randomKey(prefix: string) {
  // Non-cryptographic placeholder for docs/preview. Server issues real keys.
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 40; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}_${s}`;
}

function generateEnv(o: { plan: Plan; target: Target; projectName: string; region: string; anonKey: string; serviceKey: string; jwt: string }) {
  const t = TARGET_META[o.target];
  const url = o.target === "docker" ? "http://localhost:3000" : t.deployUrl.replace("YOUR-APP", slug(o.projectName));
  return [
    `# Pluto BaaS — ${PLAN_META[o.plan].title} on ${t.title}`,
    `# generated ${new Date().toISOString()}`,
    ``,
    `PLUTO_URL=${url}`,
    `PLUTO_REGION=${o.region.split(" ")[0]}`,
    `PLUTO_ANON_KEY=${o.anonKey}`,
    `PLUTO_SERVICE_ROLE_KEY=${o.serviceKey}    # server-side only, never ship to browser`,
    `PLUTO_JWT_SECRET=${o.jwt}`,
    ``,
    `# Frontend (React / Vue) — Vite`,
    `VITE_PLUTO_URL=${url}`,
    `VITE_PLUTO_ANON_KEY=${o.anonKey}`,
  ].join("\n");
}

export function OnboardingWizard({ initialPlan, onDismiss }: { initialPlan: Plan; onDismiss: () => void }) {
  const persisted = useMemo(loadPersisted, []);
  const startsFromPersisted = persisted.plan === initialPlan;

  const [plan, setPlan] = useState<Plan>(initialPlan);
  const [target, setTarget] = useState<Target>(
    (startsFromPersisted && persisted.target && PLAN_META[initialPlan].targets.includes(persisted.target))
      ? persisted.target
      : PLAN_META[initialPlan].defaultTarget
  );
  const [projectName, setProjectName] = useState(startsFromPersisted ? persisted.projectName ?? "" : "");
  const [region, setRegion] = useState(startsFromPersisted ? persisted.region ?? REGIONS[0] : REGIONS[0]);
  const [step, setStep] = useState(startsFromPersisted ? Math.min(persisted.step ?? 0, 3) : 0);
  const [copied, setCopied] = useState(false);

  // Keys are re-generated on each mount but stable across step navigation.
  const [keys] = useState(() => ({
    anon: randomKey("pluto_anon"),
    service: randomKey("pluto_srv"),
    jwt: randomKey("jwt"),
  }));

  // If user changes plan from prop (via URL) mid-flow, sync
  useEffect(() => {
    if (initialPlan !== plan) {
      setPlan(initialPlan);
      if (!PLAN_META[initialPlan].targets.includes(target)) {
        setTarget(PLAN_META[initialPlan].defaultTarget);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPlan]);

  // Persist on every change
  useEffect(() => {
    savePersisted({ plan, target, projectName, region, step, ts: Date.now() });
  }, [plan, target, projectName, region, step]);

  const envText = generateEnv({
    plan, target,
    projectName: projectName || "my-app",
    region,
    anonKey: keys.anon,
    serviceKey: keys.service,
    jwt: keys.jwt,
  });

  const steps: { title: string; render: () => React.ReactNode }[] = [
    {
      title: "Pick a deployment target",
      render: () => (
        <div>
          <p className="text-sm text-muted-foreground">
            {PLAN_META[plan].blurb}
          </p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {PLAN_META[plan].targets.map((t) => {
              const meta = TARGET_META[t];
              const Icon = meta.icon;
              const active = target === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  aria-pressed={active}
                  className={`flex items-start gap-3 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active ? "border-primary/60 bg-primary/5" : "border-border bg-card hover:border-border/80"
                  }`}
                >
                  <Icon className={`mt-0.5 h-4 w-4 ${active ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium">{meta.title}</div>
                    <div className="text-xs text-muted-foreground">{meta.hint}</div>
                    <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">{meta.command}</code>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ),
    },
    {
      title: "Name your project",
      render: () => (
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Project name</span>
            <input
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="my-app"
              autoFocus
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="text-xs text-muted-foreground">Slug: <code className="font-mono">{slug(projectName)}</code></span>
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="font-medium">Region</span>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value)}
              className="rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
      ),
    },
    {
      title: "Copy your generated .env",
      render: () => (
        <div>
          <p className="text-sm text-muted-foreground">
            Paste this into your frontend project. Keys are placeholders — the server re-issues real ones on first boot.
          </p>
          <div className="mt-3 overflow-hidden rounded-lg border border-border bg-muted/30">
            <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-1.5">
              <span className="font-mono text-[11px] text-muted-foreground">.env.local</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(envText);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                aria-label={copied ? "Env copied" : "Copy .env to clipboard"}
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Copy className="h-3 w-3" aria-hidden="true" /> {copied ? "copied" : "copy"}
              </button>
            </div>
            <pre className="overflow-x-auto p-3 font-mono text-[11px] leading-relaxed">
              <code>{envText}</code>
            </pre>
          </div>
        </div>
      ),
    },
    {
      title: "Deploy & verify",
      render: () => {
        const meta = TARGET_META[target];
        return (
          <div className="grid gap-3 text-sm">
            <p className="text-muted-foreground">Run the following, then open the Dashboard to confirm.</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-[11px]">
              <code>
                {`# 1. deploy\n${meta.command}\n\n# 2. wait for readiness\ncurl ${TARGET_META[target].deployUrl.replace("YOUR-APP", slug(projectName || "my-app"))}/readyz\n\n# 3. finish setup in Dashboard`}
              </code>
            </pre>
            <div className="flex flex-wrap gap-2">
              <Link
                to="/dashboard/projects"
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                Open Projects <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
              <Link
                to={plan === "business" ? "/dashboard/enterprise" : "/dashboard/verify"}
                className="inline-flex items-center gap-1.5 rounded-md border border-input px-3.5 py-2 text-sm hover:bg-accent"
              >
                {plan === "business" ? "Enterprise settings" : "Run smoke tests"}
              </Link>
            </div>
          </div>
        );
      },
    },
  ];

  const canNext = step < steps.length - 1;
  const canBack = step > 0;

  return (
    <div className="mb-6 rounded-lg border border-primary/40 bg-primary/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Sparkles className="mt-0.5 h-5 w-5 flex-none text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-semibold uppercase tracking-wider text-primary">
                {PLAN_META[plan].title} onboarding
              </span>
              {startsFromPersisted && persisted.step && persisted.step > 0 ? (
                <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
                  resumed
                </span>
              ) : null}
            </div>
            <h2 className="mt-1 text-lg font-semibold">{steps[step].title}</h2>

            {/* Progress */}
            <ol aria-label="Wizard progress" className="mt-3 flex flex-wrap gap-1.5">
              {steps.map((s, i) => (
                <li key={s.title}>
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-current={i === step ? "step" : undefined}
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition ${
                      i < step
                        ? "bg-primary/20 text-primary"
                        : i === step
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/70"
                    }`}
                  >
                    {i < step ? <Check className="h-3 w-3" aria-hidden="true" /> : <span>{i + 1}</span>}
                    <span className="hidden sm:inline">{s.title}</span>
                  </button>
                </li>
              ))}
            </ol>

            <div className="mt-5">{steps[step].render()}</div>

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setStep((n) => Math.max(0, n - 1))}
                disabled={!canBack}
                className="inline-flex items-center gap-1 rounded-md border border-input px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /> Back
              </button>
              {canNext ? (
                <button
                  type="button"
                  onClick={() => setStep((n) => Math.min(steps.length - 1, n + 1))}
                  disabled={step === 1 && !projectName.trim()}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Next <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => { try { localStorage.removeItem(STORAGE_KEY); } catch {} onDismiss(); }}
                  className="inline-flex items-center gap-1 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Finish <Check className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss onboarding"
          onClick={onDismiss}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
