import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { StarterCIStatus } from "@/components/pluto/StarterCIStatus";

export const Route = createFileRoute("/dashboard/help/checklist")({
  component: ChecklistPage,
  head: () => ({
    meta: [
      { title: "Fullstack E2E Checklist — Pluto BaaS" },
      {
        name: "description",
        content:
          "Interactive step tracker for the Pluto BaaS Fullstack E2E integration guide.",
      },
      { property: "og:title", content: "Fullstack E2E Checklist — Pluto BaaS" },
      {
        property: "og:description",
        content:
          "Track your progress through the Pluto BaaS end-to-end integration guide.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
});

type Step = { id: string; label: string; hint?: string; link?: string };
type Phase = { id: string; title: string; steps: Step[] };

const PHASES: Phase[] = [
  {
    id: "p0",
    title: "Phase 0 — Prerequisites",
    steps: [
      { id: "vps", label: "VPS ready (Ubuntu 22.04+, ≥ 2 vCPU / 4 GB)" },
      { id: "dns", label: "Apex + wildcard DNS pointed to VPS IP" },
      { id: "docker", label: "Docker + Compose installed", link: "/dashboard/ops/docker-check" },
    ],
  },
  {
    id: "p1",
    title: "Phase 1 — Workspace + Project",
    steps: [
      { id: "workspace", label: "Workspace created" },
      { id: "project", label: "Project created", link: "/dashboard/projects" },
    ],
  },
  {
    id: "p2",
    title: "Phase 2 — API Keys",
    steps: [
      { id: "anon", label: "anon key minted", link: "/dashboard/projects" },
      { id: "srv", label: "service_role key minted (server-only)" },
      { id: "keys-stored", label: "Keys stored in secret manager / .env" },
    ],
  },
  {
    id: "p3",
    title: "Phase 3 — Database Schema + RLS",
    steps: [
      { id: "migration", label: "First migration created" },
      { id: "grants", label: "GRANTs for anon / authenticated added" },
      { id: "rls", label: "RLS enabled + policies", link: "/dashboard/ops/rls-debug" },
      { id: "apply", label: "Migration applied to prod", link: "/dashboard/ops/migrations" },
    ],
  },
  {
    id: "p4",
    title: "Phase 4 — Auth",
    steps: [
      { id: "signup", label: "Sign-up + sign-in works" },
      { id: "jwt", label: "JWT claims verified", link: "/dashboard/ops/jwt-inspect" },
    ],
  },
  {
    id: "p5",
    title: "Phase 5 — Frontend Wiring",
    steps: [
      { id: "env", label: ".env.local filled from starter template" },
      { id: "starter", label: "Next.js starter running (auth + notes)" },
      { id: "rls-check", label: "User can only see their own rows" },
    ],
  },
  {
    id: "p6",
    title: "Phase 6 — Storage + Realtime",
    steps: [
      { id: "bucket", label: "Storage bucket + policy created" },
      { id: "realtime", label: "Realtime subscription received" },
    ],
  },
  {
    id: "p7",
    title: "Phase 7 — Webhooks / Server logic",
    steps: [
      { id: "webhook-ep", label: "Webhook endpoint deployed" },
      { id: "hmac", label: "HMAC signature verified end-to-end" },
      { id: "ci", label: "GitHub Actions E2E workflow green" },
    ],
  },
  {
    id: "p8",
    title: "Phase 8 — Custom domain + SSL",
    steps: [
      { id: "domain", label: "Custom domain + certificate issued" },
      { id: "primary", label: "Primary frontend header present (X-Pluto-Primary)" },
    ],
  },
  {
    id: "p9",
    title: "Phase 9 — Deploy + Cutover",
    steps: [
      { id: "deploy", label: "Production build deployed" },
      { id: "verify", label: "Verification report clean" },
    ],
  },
  {
    id: "p10",
    title: "Phase 10 — Observability + Ops",
    steps: [
      { id: "webhooks-cfg", label: "Ops webhooks configured", link: "/dashboard/ops/settings" },
      { id: "backups", label: "Backup + retention policy set" },
      { id: "monitor", label: "Ops executions monitored", link: "/dashboard/ops/executions" },
    ],
  },
];

const STORAGE_KEY = "pluto.help.checklist.v1";

function loadState(): Record<string, boolean> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function ChecklistPage() {
  const [state, setState] = useState<Record<string, boolean>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setState(loadState());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, hydrated]);

  const totals = useMemo(() => {
    const all = PHASES.flatMap((p) => p.steps);
    const done = all.filter((s) => state[s.id]).length;
    return { done, total: all.length, pct: Math.round((done / all.length) * 100) };
  }, [state]);

  const toggle = (id: string) => setState((s) => ({ ...s, [id]: !s[id] }));
  const resetAll = () => setState({});
  const markPhase = (phase: Phase, value: boolean) =>
    setState((s) => {
      const next = { ...s };
      phase.steps.forEach((st) => (next[st.id] = value));
      return next;
    });

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Fullstack E2E Checklist</h1>
        <p className="text-sm text-muted-foreground">
          Track your progress through the{" "}
          <Link to="/dashboard/help/fullstack-guide" className="underline">
            Fullstack E2E Guide
          </Link>
          . Progress is stored locally in your browser.
        </p>
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 rounded bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all"
              style={{ width: `${totals.pct}%` }}
            />
          </div>
          <span className="text-sm tabular-nums">
            {totals.done} / {totals.total} ({totals.pct}%)
          </span>
          <button
            onClick={resetAll}
            className="text-xs px-2 py-1 rounded border hover:bg-accent"
          >
            Reset
          </button>
        </div>
        <StarterCIStatus />
      </header>

      <ol className="space-y-4">
        {PHASES.map((phase) => {
          const done = phase.steps.filter((s) => state[s.id]).length;
          const total = phase.steps.length;
          const complete = done === total;
          return (
            <li
              key={phase.id}
              className={`rounded-lg border p-4 ${complete ? "bg-primary/5 border-primary/40" : ""}`}
            >
              <div className="flex items-center justify-between gap-3 mb-2">
                <h2 className="font-medium">{phase.title}</h2>
                <div className="flex items-center gap-2 text-xs">
                  <span className="tabular-nums text-muted-foreground">
                    {done}/{total}
                  </span>
                  <button
                    onClick={() => markPhase(phase, true)}
                    className="px-2 py-0.5 rounded border hover:bg-accent"
                  >
                    Mark all
                  </button>
                  <button
                    onClick={() => markPhase(phase, false)}
                    className="px-2 py-0.5 rounded border hover:bg-accent"
                  >
                    Clear
                  </button>
                </div>
              </div>
              <ul className="space-y-1.5">
                {phase.steps.map((step) => (
                  <li key={step.id} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={!!state[step.id]}
                      onChange={() => toggle(step.id)}
                      id={`chk-${step.id}`}
                    />
                    <label htmlFor={`chk-${step.id}`} className="flex-1 cursor-pointer">
                      <span className={state[step.id] ? "line-through text-muted-foreground" : ""}>
                        {step.label}
                      </span>
                      {step.link && (
                        <Link
                          to={step.link}
                          className="ml-2 text-xs underline text-primary"
                        >
                          open →
                        </Link>
                      )}
                      {step.hint && (
                        <div className="text-xs text-muted-foreground">{step.hint}</div>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
