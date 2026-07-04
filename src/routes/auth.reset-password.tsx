import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Zap, CheckCircle2 } from "lucide-react";
import { isLive, live } from "@/lib/pluto/live";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/reset-password")({
  ssr: false,
  head: () => ({ meta: [{ title: "Choose a new password — Pluto BaaS" }] }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Token arrives via URL hash: `#token=...`
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    const params = new URLSearchParams(hash);
    const t = params.get("token") ?? "";
    setToken(t);
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return toast.error("Missing reset token in URL.");
    if (password.length < 8) return toast.error("Password must be at least 8 characters.");
    if (password !== confirm) return toast.error("Passwords do not match.");
    setBusy(true);
    try {
      if (isLive()) await live.auth.verifyPasswordRecovery(token, password);
      setDone(true);
      setTimeout(() => navigate({ to: "/dashboard" }), 1400);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
    } finally { setBusy(false); }
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
          {done ? (
            <div className="text-center space-y-2 py-4">
              <CheckCircle2 className="h-8 w-8 text-primary mx-auto" />
              <div className="text-sm font-medium">Password updated</div>
              <div className="text-xs text-muted-foreground">Redirecting to dashboard…</div>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-semibold">Choose a new password</h1>
              <p className="text-sm text-muted-foreground mt-1">
                কমপক্ষে 8 characters। Previous session সব logout হয়ে যাবে।
              </p>
              <form onSubmit={onSubmit} className="mt-5 space-y-3">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">New password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Confirm new password</label>
                  <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required minLength={8}
                    className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                {!token && (
                  <div className="text-[11px] text-destructive">
                    Token missing. Please use the link from your reset email.
                  </div>
                )}
                <button type="submit" disabled={busy || !token}
                  className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                  {busy ? "Updating…" : "Update password"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
