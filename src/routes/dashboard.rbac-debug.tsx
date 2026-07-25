import { createFileRoute } from "@tanstack/react-router";
import { CheckCircle2, XCircle } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { useAuth } from "@/lib/pluto/auth-context";
import {
  diagnosePermission,
  PERMISSION_REQUIREMENTS,
  type TracePermission,
} from "@/components/pluto/TraceAccessGate";

export const Route = createFileRoute("/dashboard/rbac-debug")({
  head: () => ({
    meta: [
      { title: "RBAC debug — Pluto" },
      {
        name: "description",
        content:
          "Inspect your effective role, superadmin flag, and which access gates allow or deny each capability.",
      },
    ],
  }),
  component: RbacDebugPage,
});

const GATES: { key: TracePermission; label: string; where: string }[] = [
  { key: "view", label: "View traces & trends", where: "/dashboard/traces, /dashboard/traces/trends" },
  { key: "manage", label: "Manage PII rules & alert webhooks", where: "/dashboard/traces/settings" },
];

function Verdict({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-300">
      <CheckCircle2 className="h-3.5 w-3.5" /> allowed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-xs font-medium text-rose-300">
      <XCircle className="h-3.5 w-3.5" /> denied
    </span>
  );
}

function RbacDebugPage() {
  const { session, loading } = useAuth();

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading session…</div>;
  }

  const diags = GATES.map((g) => ({ ...g, diag: diagnosePermission(session, g.key) }));
  const email = session?.user?.email ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <PageHeader
        title="RBAC debug"
        description="Effective role, superadmin flag, and per-gate verdicts for the currently signed-in user."
      />

      {!session ? (
        <div className="rounded-2xl border border-border/60 bg-card/60 p-6 text-sm text-muted-foreground">
          Not signed in — RBAC gates cannot be evaluated.
        </div>
      ) : (
        <>
          <section className="rounded-2xl border border-border/60 bg-card/60 p-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Effective identity
            </h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 font-mono text-sm">
              <dt className="text-muted-foreground">email</dt>
              <dd>{email ?? "(unknown)"}</dd>
              <dt className="text-muted-foreground">role</dt>
              <dd>{diags[0].diag.role || <span className="text-muted-foreground">(none)</span>}</dd>
              <dt className="text-muted-foreground">is_superadmin</dt>
              <dd>{diags[0].diag.isSuperadmin ? "true" : "false"}</dd>
              <dt className="text-muted-foreground">user_id</dt>
              <dd>{session.user?.id ?? "-"}</dd>
            </dl>
          </section>

          <section className="rounded-2xl border border-border/60 bg-card/60 p-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Access gates
            </h2>
            <div className="space-y-3">
              {diags.map(({ key, label, where, diag }) => (
                <div
                  key={key}
                  className="rounded-lg border border-border/40 bg-background/40 p-4"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">{label}</div>
                      <div className="text-xs text-muted-foreground">{where}</div>
                    </div>
                    <Verdict ok={diag.allowed} />
                  </div>
                  <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-xs font-mono">
                    <dt className="text-muted-foreground">permission</dt>
                    <dd>{key}</dd>
                    <dt className="text-muted-foreground">required</dt>
                    <dd>
                      role ∈ [{diag.requirement.roles.join(", ")}]{" "}
                      <span className="text-muted-foreground">or</span> is_superadmin=true
                    </dd>
                    <dt className="text-muted-foreground">matched</dt>
                    <dd>{diag.matched ?? "-"}</dd>
                    <dt className="text-muted-foreground">reason</dt>
                    <dd className="whitespace-pre-wrap">{diag.reason}</dd>
                  </dl>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-border/60 bg-card/60 p-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Raw session field lookup
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              These are the exact locations the gate reads. If a field you expect
              is <code>undefined</code>, the backend/session adapter isn't
              propagating it.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <div className="mb-1 text-xs font-semibold text-muted-foreground">Role sources</div>
                <ul className="space-y-1 font-mono text-xs">
                  {diags[0].diag.rawRoleSources.map((r) => (
                    <li key={r.location} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{r.location}</span>
                      <span>{JSON.stringify(r.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <div className="mb-1 text-xs font-semibold text-muted-foreground">
                  Superadmin sources
                </div>
                <ul className="space-y-1 font-mono text-xs">
                  {diags[0].diag.superadminSources.map((r) => (
                    <li key={r.location} className="flex justify-between gap-3">
                      <span className="text-muted-foreground">{r.location}</span>
                      <span>{JSON.stringify(r.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-border/60 bg-card/60 p-6">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Permission requirements
            </h2>
            <ul className="space-y-2 text-sm">
              {(Object.keys(PERMISSION_REQUIREMENTS) as TracePermission[]).map((p) => (
                <li key={p} className="font-mono text-xs">
                  <span className="font-semibold">{p}</span> →{" "}
                  {PERMISSION_REQUIREMENTS[p].description}
                </li>
              ))}
            </ul>
          </section>

          <details className="rounded-2xl border border-border/60 bg-card/60 p-6">
            <summary className="cursor-pointer text-sm font-semibold text-muted-foreground">
              Full session JSON (sensitive)
            </summary>
            <pre className="mt-3 overflow-auto rounded-md bg-background/60 p-3 text-xs">
              {JSON.stringify(
                { ...session, access_token: "<redacted>", refresh_token: "<redacted>" },
                null,
                2,
              )}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}
