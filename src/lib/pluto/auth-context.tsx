import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { pluto, type PlutoSession } from "./client";

type AuthCtx = {
  session: PlutoSession | null;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  loading: boolean;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<PlutoSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setSession(pluto.auth.getSession());
    setLoading(false);
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const s = await pluto.auth.signIn(email, password);
    setSession(s);
  }, []);

  const signOut = useCallback(async () => {
    await pluto.auth.signOut();
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
