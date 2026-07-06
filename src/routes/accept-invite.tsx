import { createFileRoute, useSearch, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { live } from "@/lib/pluto/live";

type Search = { token?: string };

export const Route = createFileRoute("/accept-invite")({
  head: () => ({ meta: [{ title: "Accept your Pluto invite" }] }),
  validateSearch: (search: Record<string, unknown>): Search => ({
    token: typeof search.token === "string" ? search.token : undefined,
  }),
  component: AcceptInvitePage,
});

function AcceptInvitePage() {
  const { token } = useSearch({ from: "/accept-invite" });
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) { setErr("Missing invite token."); return; }
    setBusy(true); setErr(null);
    try {
      await live.onboarding.acceptInvite(token, password);
      navigate({ to: "/dashboard" });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-1">Set your password</h1>
        <p className="text-sm text-muted-foreground mb-6">Your workspace is ready — just pick a password to sign in.</p>

        {!token && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive mb-4">
          This invite link is missing its token. Ask the sender for a fresh link.
        </div>}

        <form onSubmit={onSubmit} className="space-y-4">
          <input type="password" required minLength={8} value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="New password (min 8 chars)"
            disabled={!token}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
          {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{err}</div>}
          <button type="submit" disabled={busy || !token}
            className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {busy ? "Setting up…" : "Accept invite"}
          </button>
        </form>
      </div>
    </div>
  );
}
