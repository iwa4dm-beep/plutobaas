import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { KeyRound, Shield, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { isLive, mfa, type MfaFactor, type MfaEnrollResponse } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/mfa")({
  component: MfaPage,
});

// ============================================================
// MFA (TOTP) — Phase 15
// ------------------------------------------------------------
// Enrollment + verification + recovery codes surface. When the
// backend module (PLUTO_ENABLE_ADVANCED_AUTH=1) is off or the
// 15.1 handlers haven't landed yet, every call returns a
// friendly 501 — surfaced inline below the form.
// ============================================================

function MfaPage() {
  const live = isLive();
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [enroll, setEnroll] = useState<MfaEnrollResponse | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<string[] | null>(null);

  const refresh = async () => {
    if (!live) return;
    try {
      const r = await mfa.list();
      setFactors(r.factors);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  useEffect(() => { void refresh(); }, [live]);

  const doEnroll = async () => {
    setBusy(true); setErr(null);
    try { setEnroll(await mfa.enroll("Authenticator")); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const doVerify = async () => {
    if (!enroll) return;
    setBusy(true); setErr(null);
    try {
      await mfa.verify(enroll.factor_id, code);
      setEnroll(null); setCode("");
      await refresh();
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const doRevoke = async (id: string) => {
    setBusy(true);
    try { await mfa.revoke(id); await refresh(); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  const doRecovery = async () => {
    setBusy(true); setErr(null);
    try { const r = await mfa.recoveryCodes(); setRecovery(r.codes); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Multi-factor authentication"
        description="Time-based one-time passwords (TOTP) and single-use recovery codes. Phase 15 — handlers land in 15.1."

      />

      {!live && (
        <Card>
          <CardContent className="py-4 text-sm text-muted-foreground">
            Configure <code>VITE_PLUTO_URL</code> and <code>VITE_PLUTO_ANON_KEY</code> to enable MFA.
          </CardContent>
        </Card>
      )}

      {err && (
        <Card className="border-destructive/50">
          <CardContent className="py-3 text-sm text-destructive">{err}</CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Smartphone className="h-4 w-4" />
              Enroll authenticator
            </CardTitle>
            <CardDescription>
              Scan the otpauth URL in Google Authenticator, 1Password, Authy, etc.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {!enroll ? (
              <Button onClick={doEnroll} disabled={!live || busy}>Start enrollment</Button>
            ) : (
              <div className="space-y-3">
                <div className="rounded-md border bg-muted/40 p-3 text-xs break-all font-mono">
                  {enroll.otpauth_url}
                </div>
                <div className="text-xs text-muted-foreground">
                  Manual secret: <code>{enroll.secret}</code>
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="6-digit code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    maxLength={8}
                  />
                  <Button onClick={doVerify} disabled={busy || code.length < 6}>Verify</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <KeyRound className="h-4 w-4" />
              Recovery codes
            </CardTitle>
            <CardDescription>
              Generated once. Store safely — each code is single-use.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button variant="outline" onClick={doRecovery} disabled={!live || busy}>
              Generate 10 new codes
            </Button>
            {recovery && (
              <div className="grid grid-cols-2 gap-1 text-xs font-mono rounded-md border p-3 bg-muted/30">
                {recovery.map((c) => <div key={c}>{c}</div>)}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4" />
            Enrolled factors
          </CardTitle>
        </CardHeader>
        <CardContent>
          {factors.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No factors enrolled yet.
            </div>
          ) : (
            <div className="divide-y">
              {factors.map((f) => (
                <div key={f.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-sm font-medium">
                      {f.friendly_name ?? f.factor_type.toUpperCase()}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Added {new Date(f.created_at).toLocaleString()}
                      {f.last_used_at && ` · last used ${new Date(f.last_used_at).toLocaleString()}`}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={f.status === "verified" ? "default" : "secondary"}>
                      {f.status}
                    </Badge>
                    <Button size="sm" variant="ghost" onClick={() => doRevoke(f.id)} disabled={busy}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
