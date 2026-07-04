import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Zap } from "lucide-react";
import { useAuth } from "@/lib/pluto/auth-context";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign in — Pluto BaaS" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { session, signIn, loading } = useAuth();
  const [email, setEmail] = useState("admin@pluto.local");
  const [password, setPassword] = useState("admin");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/dashboard" });
  }, [loading, session, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 justify-center mb-8">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Zap className="h-4 w-4" />
          </div>
          <span className="font-semibold tracking-tight text-lg">Pluto BaaS</span>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">Admin sign-in</h1>
          <p className="text-sm text-muted-foreground mt-1">আপনার Pluto instance-এ লগ-ইন করুন।</p>

          <form onSubmit={onSubmit} className="mt-5 space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                required
              />
            </div>
            {error && <div className="text-xs text-destructive">{error}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-3 flex items-center justify-between text-[11px]">
            <Link to="/auth/forgot" className="text-muted-foreground hover:text-foreground">Forgot password?</Link>
            <Link to="/auth/phone" className="text-muted-foreground hover:text-foreground">Sign in with phone</Link>
          </div>

          <p className="mt-4 text-[11px] text-muted-foreground text-center">
            Mock mode: যেকোনো email/password দিয়ে log in করতে পারবেন।
          </p>
        </div>
      </div>
    </div>
  );
}
