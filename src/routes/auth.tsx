import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { LogIn, UserPlus, Zap } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/lib/pluto/auth-context";
import { describeError, isLive } from "@/lib/pluto/live";
import { ErrorBanner } from "@/components/pluto/ErrorBanner";

export const Route = createFileRoute("/auth")({
  ssr: false,
  head: () => ({ meta: [{ title: "Sign in — Pluto BaaS" }] }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { session, signIn, signUp, loading } = useAuth();
  const [mode, setMode] = useState<"signin" | "signup">("signup");
  const [email, setEmail] = useState("admin@timescard.cloud");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!loading && session) navigate({ to: "/dashboard" });
  }, [loading, session, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signup") {
        if (password.length < 8) throw new Error("Password কমপক্ষে 8 characters হতে হবে।");
        if (password !== confirmPassword) throw new Error("Password confirmation মিলছে না।");
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err);
      const info = describeError(err);
      toast.error(mode === "signup" ? "Sign-up failed" : "Sign-in failed", {
        description: info.detail ?? info.title,
      });
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
          <h1 className="text-lg font-semibold">Admin authentication</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {mode === "signup" ? "প্রথমে root admin account তৈরি করুন।" : "আপনার Pluto instance-এ লগ-ইন করুন।"}
          </p>

          <div className="mt-5 grid grid-cols-2 rounded-md border border-border bg-muted/30 p-1">
            <button
              type="button"
              onClick={() => { setMode("signin"); setError(null); }}
              className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition ${mode === "signin" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <LogIn className="h-3.5 w-3.5" /> Sign in
            </button>
            <button
              type="button"
              onClick={() => { setMode("signup"); setError(null); }}
              className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition ${mode === "signup" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              <UserPlus className="h-3.5 w-3.5" /> Sign up
            </button>
          </div>

          <form onSubmit={onSubmit} className="mt-4 space-y-3">
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
                minLength={mode === "signup" ? 8 : undefined}
                placeholder={mode === "signup" ? "Minimum 8 characters" : undefined}
                className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                required
              />
            </div>
            {mode === "signup" && (
              <div>
                <label className="text-xs font-medium text-muted-foreground">Confirm password</label>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  minLength={8}
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  required
                />
              </div>
            )}
            {error && <div className="text-xs text-destructive">{error}</div>}
            <button
              type="submit"
              disabled={busy}
              className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              {busy ? (mode === "signup" ? "Creating account…" : "Signing in…") : (mode === "signup" ? "Create account" : "Sign in")}
            </button>
          </form>

          <div className="mt-3 flex items-center justify-between text-[11px]">
            <Link to="/auth/forgot" className="text-muted-foreground hover:text-foreground">Forgot password?</Link>
            <Link to="/auth/phone" className="text-muted-foreground hover:text-foreground">Sign in with phone</Link>
          </div>

          {!isLive() && (
            <p className="mt-4 text-[11px] text-muted-foreground text-center">
              Mock mode: যেকোনো email/password দিয়ে log in করতে পারবেন।
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
