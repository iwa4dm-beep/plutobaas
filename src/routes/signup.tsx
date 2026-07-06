import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { live, type SignupFullResult } from "@/lib/pluto/live";

export const Route = createFileRoute("/signup")({
  head: () => ({
    meta: [
      { title: "Create your Pluto account" },
      { name: "description", content: "Sign up for Pluto — get a workspace, API keys, and a live backend in seconds." },
    ],
  }),
  component: SignupPage,
});

function SignupPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [domain, setDomain] = useState("");
  const [seedDemo, setSeedDemo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const r: SignupFullResult = await live.onboarding.signupFull({
        email, password, workspace_name: workspaceName,
        initial_domain: domain.trim() || undefined,
        seed_demo: seedDemo,
      });
      // Stash the fresh keys for the wizard; keys are shown ONCE.
      sessionStorage.setItem("pluto:onboarding", JSON.stringify(r));
      // Auto-login
      await live.auth.signIn(email, password);
      navigate({ to: "/onboarding" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-semibold mb-1">Create your Pluto account</h1>
        <p className="text-sm text-muted-foreground mb-8">
          You will get a workspace, API keys, and a live backend in seconds.
        </p>

        <form onSubmit={onSubmit} className="space-y-4">
          <Field label="Email">
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Password" hint="Minimum 8 characters">
            <input type="password" required minLength={8} value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Workspace name" hint="What is your company or project called?">
            <input required value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)}
              placeholder="Acme Inc" minLength={2} maxLength={80}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </Field>
          <Field label="Website (optional)" hint="Auto-added to your CORS whitelist">
            <input value={domain} onChange={(e) => setDomain(e.target.value)}
              placeholder="https://app.example.com"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          </Field>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={seedDemo} onChange={(e) => setSeedDemo(e.target.checked)} />
            Seed a demo table (customers + orders) so I can try the SDK immediately
          </label>

          {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}

          <button type="submit" disabled={busy}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Creating your backend…" : "Create account"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          Already have an account? <Link to="/auth" className="text-primary hover:underline">Sign in</Link>
        </p>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-sm font-medium">{label}</label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {children}
    </div>
  );
}
