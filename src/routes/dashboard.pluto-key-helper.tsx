// Pluto admin JWT helper — detects the configured PLUTO_SERVICE_ROLE_KEY
// format, mints an HS256 JWT from PLUTO_JWT_SECRET when the key isn't a JWT,
// and probes it against the live admin API.
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AlertTriangle, CheckCircle2, Copy, KeyRound, Loader2, RefreshCw, Wand2, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  inspectServiceKey, mintAdminJwt, probeAdminKey,
  type KeyInspectResult, type MintJwtResult, type ProbeResult,
} from "@/lib/pluto/key-helper.functions";

export const Route = createFileRoute("/dashboard/pluto-key-helper")({
  component: KeyHelperPage,
});

function KeyHelperPage() {
  const inspectFn = useServerFn(inspectServiceKey);
  const mintFn    = useServerFn(mintAdminJwt);
  const probeFn   = useServerFn(probeAdminKey);

  const [inspect, setInspect] = useState<KeyInspectResult | null>(null);
  const [minted,  setMinted]  = useState<MintJwtResult | null>(null);
  const [probe,   setProbe]   = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState<"inspect" | "mint" | "probe" | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [ttlDays, setTtlDays] = useState(365);
  const [copied,  setCopied]  = useState(false);

  const refresh = useCallback(async () => {
    setLoading("inspect"); setError(null);
    try { setInspect(await inspectFn()); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  }, [inspectFn]);

  useEffect(() => { void refresh(); }, [refresh]);

  const mint = async () => {
    setLoading("mint"); setError(null); setMinted(null);
    try {
      const r = await mintFn({ data: { role: "service_role", ttlSeconds: ttlDays * 86400 } });
      setMinted(r);
      if (!r.ok) setError(r.error);
    } catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  };

  const probeConfigured = async () => {
    setLoading("probe"); setError(null); setProbe(null);
    try { setProbe(await probeFn({ data: {} })); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  };

  const probeMinted = async () => {
    if (!minted?.ok) return;
    setLoading("probe"); setError(null); setProbe(null);
    try { setProbe(await probeFn({ data: { token: minted.token } })); }
    catch (e) { setError((e as Error).message); }
    finally { setLoading(null); }
  };

  const copy = (v: string) => {
    void navigator.clipboard.writeText(v).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const fmtKind = inspect?.format.kind;
  const roleTxt = inspect?.format.kind === "jwt" ? inspect.format.role : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Admin JWT helper"
        description="Detects the format of the configured PLUTO_SERVICE_ROLE_KEY. If it isn't a JWT (which fastify-jwt requires), you can mint one server-side using PLUTO_JWT_SECRET and probe it against the live admin API."
        actions={
          <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading === "inspect"}>
            {loading === "inspect" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            <span className="ml-1.5">Re-inspect</span>
          </Button>
        }
      />

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {/* ── Detected format ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Configured key
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-2">
          {!inspect ? (
            <div className="text-muted-foreground">Loading…</div>
          ) : !inspect.hasKey ? (
            <div className="text-amber-500">PLUTO_SERVICE_ROLE_KEY is not set.</div>
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant={inspect.adminCompatible ? "default" : "destructive"}>
                  {inspect.adminCompatible ? "admin-compatible" : "NOT admin-compatible"}
                </Badge>
                <Badge variant="secondary">{inspect.description}</Badge>
                <span className="text-muted-foreground">
                  {inspect.length} chars · preview <code>{inspect.preview}</code>
                </span>
              </div>
              <div className="text-muted-foreground">
                VPS: <code>{inspect.vpsBaseUrl}</code>
              </div>
              {fmtKind === "jwt" && roleTxt && (
                <div className="text-muted-foreground">JWT payload role: <code>{roleTxt}</code></div>
              )}
              {!inspect.adminCompatible && (
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    fastify-jwt (Pluto admin API) requires an <code>eyJ…</code> HS256 JWT with <code>role: "service_role"</code>.
                    The current key won't authenticate against <code>/admin/v1/*</code>. Mint one below or paste an existing JWT into the secret via Settings → Secrets.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Live probe ──────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            Probe admin API
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-2">
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => void probeConfigured()} disabled={loading === "probe" || !inspect?.hasKey}>
              {loading === "probe" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Probe with configured key</span>
            </Button>
            {minted?.ok && (
              <Button size="sm" onClick={() => void probeMinted()} disabled={loading === "probe"}>
                {loading === "probe" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                <span className="ml-1.5">Probe with minted JWT</span>
              </Button>
            )}
          </div>
          {probe && (
            <div className="rounded border bg-background p-2 space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant={probe.ok ? "default" : "destructive"}>HTTP {probe.status || "network error"}</Badge>
                <span className="text-muted-foreground">{probe.latencyMs}ms · <code>{probe.url}</code></span>
              </div>
              <pre className="whitespace-pre-wrap font-mono text-[11px] leading-4 max-h-40 overflow-y-auto">
{probe.bodyPreview || "(empty)"}
              </pre>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Mint JWT ────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Wand2 className="h-4 w-4" />
            Mint admin JWT
          </CardTitle>
        </CardHeader>
        <CardContent className="text-xs space-y-3">
          {inspect && !inspect.jwtSecretAvailable && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                <code>PLUTO_JWT_SECRET</code> is not set. Add it via Settings → Secrets — the value must match the Pluto backend's <code>JWT_SECRET</code> (from its <code>.env</code> file on the VPS), otherwise fastify-jwt will reject the minted token.
              </AlertDescription>
            </Alert>
          )}

          <div className="flex items-end gap-2 flex-wrap">
            <div>
              <Label className="text-xs">TTL (days)</Label>
              <Input
                type="number"
                min={1}
                max={400}
                value={ttlDays}
                onChange={(e) => setTtlDays(Math.max(1, Math.min(400, Number(e.target.value) || 1)))}
                className="w-28 h-8"
              />
            </div>
            <Button size="sm" onClick={() => void mint()} disabled={loading === "mint" || !inspect?.jwtSecretAvailable}>
              {loading === "mint" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              <span className="ml-1.5">Mint service_role JWT</span>
            </Button>
          </div>

          {minted?.ok && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-emerald-500">
                <CheckCircle2 className="h-3.5 w-3.5" />
                <span>Minted · expires {new Date(minted.expiresAt * 1000).toISOString()}</span>
              </div>
              <div className="relative">
                <pre className="rounded border bg-background p-2 font-mono text-[11px] leading-4 max-h-32 overflow-y-auto break-all whitespace-pre-wrap">
{minted.token}
                </pre>
                <Button
                  size="sm"
                  variant="ghost"
                  className="absolute top-1 right-1 h-7 px-2"
                  onClick={() => copy(minted.token)}
                >
                  <Copy className="h-3 w-3" />
                  <span className="ml-1">{copied ? "copied" : "copy"}</span>
                </Button>
              </div>
              <Alert>
                <AlertDescription className="text-xs">
                  Copy this token and save it as <code>PLUTO_SERVICE_ROLE_KEY</code> in Settings → Secrets, then click <em>Re-inspect</em> above. The <em>Probe with minted JWT</em> button lets you verify it before saving.
                </AlertDescription>
              </Alert>
            </div>
          )}
          {minted && !minted.ok && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">{minted.error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
