import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { pluto, type PlutoSession } from "./client";
import { isLive, live } from "./live";

type AuthCtx = {
  session: PlutoSession | null;
  signIn: (email: string, password: string) => Promise<void>;
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
    userId: s.user.id,
    email:  s.user.email,
    role:   s.user.role,
    token:  s.access_token,
  } as unknown as PlutoSession;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlutoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Consume `#access_token=…` fragment after an OAuth redirect-back so
    // the session is persisted before we read it.
    if (isLive()) live.auth.completeOAuthRedirect();
    setSession(isLive() ? liveSessionToPluto() : pluto.auth.getSession());
    setLoading(false);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (isLive()) {
      await live.auth.signIn(email, password);
      setSession(liveSessionToPluto());
    } else {
      const s = await pluto.auth.signIn(email, password);
      setSession(s);
    }
  }, []);

  const signOut = useCallback(async () => {
    if (isLive()) await live.auth.signOut();
    else await pluto.auth.signOut();
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, signIn, signOut, loading }), [session, signIn, signOut, loading]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth must be used inside <AuthProvider>");
  return v;
}
