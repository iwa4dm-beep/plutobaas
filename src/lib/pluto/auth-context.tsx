import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { pluto, type PlutoSession } from "./client";
import { isLive, live } from "./live";

type AuthCtx = {
  session: PlutoSession | null;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  loading: boolean;
};

const Ctx = createContext<AuthCtx | null>(null);

// Adapt the live-auth session shape (access_token + user{ id, email,
// role }) to the PlutoSession shape the dashboard is written against.
function liveSessionToPluto(): PlutoSession | null {
  const s = live.auth.session();
  if (!s) return null;
  return {
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_at: s.expires_at,
    user: {
      id: s.user.id,
      email: s.user.email,
      role: s.user.role === "admin" ? "admin" : "user",
      created_at: s.user.created_at ?? "",
      email_verified: s.user.email_verified ?? Boolean(s.user.email_confirmed_at),
    },
  };
}


export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlutoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isLive()) live.auth.completeOAuthRedirect();
    setSession(isLive() ? liveSessionToPluto() : pluto.auth.getSession());
    setLoading(false);

    if (!isLive()) return;

    // Listen for cross-tab session changes + refresh events + hard sign-outs.
    const onStorage = (e: StorageEvent) => {
      if (e.key === "pluto.session.v1") setSession(liveSessionToPluto());
    };
    const onRefreshed = () => setSession(liveSessionToPluto());
    const onSignedOut = () => setSession(null);
    window.addEventListener("storage", onStorage);
    window.addEventListener("pluto:auth:refreshed", onRefreshed as EventListener);
    window.addEventListener("pluto:auth:signed-out", onSignedOut as EventListener);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("pluto:auth:refreshed", onRefreshed as EventListener);
      window.removeEventListener("pluto:auth:signed-out", onSignedOut as EventListener);
    };
  }, []);

  // Proactive refresh: schedule a refresh ~60s before expiry.
  useEffect(() => {
    if (!isLive() || !session?.expires_at) return;
    const msUntilExpiry = session.expires_at * 1000 - Date.now();
    const delay = Math.max(5_000, msUntilExpiry - 60_000);
    const t = setTimeout(() => {
      live.auth.refresh().then(() => setSession(liveSessionToPluto())).catch(() => setSession(null));
    }, delay);
    return () => clearTimeout(t);
  }, [session?.access_token, session?.expires_at]);

  const signIn = useCallback(async (email: string, password: string) => {
    if (isLive()) {
      await live.auth.signIn(email, password);
      setSession(liveSessionToPluto());
    } else {
      const s = await pluto.auth.signIn(email, password);
      setSession(s);
    }
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (isLive()) {
      await live.auth.signUp(email, password);
      setSession(liveSessionToPluto());
    } else {
      const s = await pluto.auth.signUp(email, password);
      setSession(s);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (isLive()) await live.auth.signOut();
    else await pluto.auth.signOut();
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, signIn, signUp, signOut, loading }), [session, signIn, signUp, signOut, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
