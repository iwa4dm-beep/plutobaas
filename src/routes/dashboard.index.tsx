import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Database, Files, ScrollText, Users, Sparkles, X } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto } from "@/lib/pluto/client";
import { isLive, live } from "@/lib/pluto/live";

type Plan = "self-hosted" | "starter" | "business";
const PLAN_INFO: Record<Plan, { title: string; steps: string[]; nextTo: string; nextLabel: string }> = {
  "self-hosted": {
    title: "Self-Hosted onboarding",
    steps: [
      "Clone the repo and run `docker compose up -d`",
      "Open http://localhost:8080 and finish first-run setup",
      "Copy the anon key from Projects → Keys into your frontend .env",
    ],
    nextTo: "/dashboard/projects",
    nextLabel: "Create your first project",
  },
  starter: {
    title: "Cloud Starter — 14-day trial",
    steps: [
      "Create a project (region + Postgres size)",
      "Add your production domain to the CORS whitelist",
      "Copy the anon key and wire the SDK into your frontend",
    ],
    nextTo: "/dashboard/projects",
    nextLabel: "Provision Starter project",
  },
  business: {
    title: "Business onboarding",
    steps: [
      "Invite teammates and assign RBAC roles",
      "Enable SAML SSO and audit-log export in Enterprise settings",
      "Schedule a deployment call with our team",
    ],
    nextTo: "/dashboard/enterprise",
    nextLabel: "Configure Business features",
  },
};

export const Route = createFileRoute("/dashboard/")({
  validateSearch: (s: Record<string, unknown>): { plan?: Plan } => {
    const p = s.plan;
    return p === "self-hosted" || p === "starter" || p === "business" ? { plan: p } : {};
  },
  component: Overview,
});

function Overview() {
  const { plan } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [stats, setStats] = useState({ users: 0, tables: 0, buckets: 0, logs: 0 });
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<"mock" | "live">(isLive() ? "live" : "mock");

  useEffect(() => {
    (async () => {
      try {
        if (isLive()) {
          const [s, l, sch] = await Promise.all([
            live.admin.stats(),
            live.admin.logs({ limit: 100 }),
            live.schema.introspect().catch(() => ({ tables: [] as unknown[] })),
          ]);
          setStats({ users: s.users, tables: sch.tables.length, buckets: s.buckets, logs: l.length });
          setSource("live");
          return;
        }
        const [u, t, b, l] = await Promise.all([
          pluto.users.list(), pluto.db.listTables(),
          pluto.storage.listBuckets(), pluto.logs.list(),
        ]);
        setStats({ users: u.length, tables: t.length, buckets: b.length, logs: l.length });
      } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);

  const cards = [
    { label: "Users", value: stats.users, icon: Users },
    { label: "Tables", value: stats.tables, icon: Database },
    { label: "Buckets", value: stats.buckets, icon: Files },
    { label: "Recent logs", value: stats.logs, icon: ScrollText },
  ];

  const info = plan ? PLAN_INFO[plan] : null;

  return (
    <div>
      <PageHeader
        title="Overview"
        description={`আপনার Pluto instance-এর সংক্ষিপ্ত অবস্থা।${source === "live" ? " (live)" : " (mock)"}`}
      />

      {info && (
        <div className="mb-6 rounded-lg border border-primary/40 bg-primary/5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <Sparkles className="mt-0.5 h-5 w-5 text-primary" aria-hidden="true" />
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-primary">Plan selected: {plan}</div>
                <h2 className="mt-1 text-lg font-semibold">{info.title}</h2>
                <ol className="mt-3 space-y-1.5 text-sm text-muted-foreground">
                  {info.steps.map((s, i) => (
                    <li key={s} className="flex gap-2">
                      <span className="font-mono text-primary">{i + 1}.</span>
                      <span>{s}</span>
                    </li>
                  ))}
                </ol>
                <Link
                  to={info.nextTo}
                  className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {info.nextLabel}
                </Link>
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss onboarding"
              onClick={() => navigate({ to: "/dashboard", search: {} })}
              className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}


      {err && (
        <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {err}
        </div>
      )}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">

        {cards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-3 text-3xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-lg border border-border bg-card p-6">
        <h2 className="font-medium">Connect your frontend</h2>
        <p className="text-sm text-muted-foreground mt-1">নিচের snippet দিয়ে যেকোনো app থেকে এই backend-এ connect করুন।</p>
        <pre className="mt-4 rounded-md bg-muted/40 p-4 text-xs overflow-x-auto"><code>{`import { createPlutoClient } from "@pluto/client";

const pluto = createPlutoClient({
  url: "http://localhost:8000",
  anonKey: "YOUR_PROJECT_ANON_KEY",
});

// Auth
await pluto.auth.signIn({ email, password });

// Auto REST
const { data } = await pluto
  .from("posts")
  .select("id, title")
  .order("created_at", { ascending: false });

// Storage
await pluto.storage.from("avatars").upload("me.png", file);`}</code></pre>
      </div>
    </div>
  );
}
