import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Zap, ArrowLeft } from "lucide-react";
import { isLive, live } from "@/lib/pluto/live";
import { toast } from "sonner";

export const Route = createFileRoute("/auth/forgot")({
  ssr: false,
  head: () => ({ meta: [{ title: "Reset your password — Pluto BaaS" }] }),
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (isLive()) await live.auth.resetPasswordForEmail(email);
      setSent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
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
          <h1 className="text-lg font-semibold">Reset your password</h1>
          <p className="text-sm text-muted-foreground mt-1">
            আমরা একটি reset link পাঠাব এই email address-এ।
          </p>

          {sent ? (
            <div className="mt-5 space-y-3">
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-xs">
                যদি সেই email-এ কোনো account থাকে, আমরা reset instructions পাঠিয়ে দিয়েছি।
                Link 30 মিনিটে expire হবে।
              </div>
              <Link to="/auth" className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-5 space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Email</label>
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                  className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <button type="submit" disabled={busy}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60">
                {busy ? "Sending…" : "Send reset link"}
              </button>
              <Link to="/auth" className="text-xs flex items-center gap-1 text-muted-foreground hover:text-foreground">
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
