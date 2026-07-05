import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { plutoApi, pushUiHistory, getUpstream } from "@/lib/pluto/upstream";

export const Route = createFileRoute("/dashboard/pluto-auth-advanced")({
  component: AuthAdvPage,
  head: () => ({ meta: [{ title: "Pluto Auth — OAuth, MFA, SSO" }] }),
});

const PROVIDERS = ["google", "github", "apple", "azure", "discord", "facebook", "custom"] as const;

function AuthAdvPage() {
  const [projectId, setProjectId] = useState("");
  const [tab, setTab] = useState<"oauth" | "mfa" | "saml">("oauth");
  const [err, setErr] = useState<string | null>(null);

  const [providers, setProviders] = useState<any[]>([]);
  const [oform, setOform] = useState({
    provider: "google" as (typeof PROVIDERS)[number],
    client_id: "", client_secret: "", redirect_uri: "", scopes: "openid,email,profile",
  });

  const [factors, setFactors] = useState<any[]>([]);
  const [enroll, setEnroll] = useState<any | null>(null);
  const [code, setCode] = useState("");

  const [saml, setSaml] = useState<any[]>([]);
  const [sform, setSform] = useState({ name: "", entity_id: "", sso_url: "", x509_cert: "" });

  const { url } = getUpstream();

  async function refresh() {
    if (!projectId) return;
    try {
      const [p, s] = await Promise.all([
        plutoApi<any[]>(`/admin/v1/oauth/providers?project_id=${projectId}`),
        plutoApi<any[]>(`/admin/v1/saml/providers?project_id=${projectId}`),
      ]);
      setProviders(p); setSaml(s);
      setFactors(await plutoApi<any[]>(`/auth/v1/mfa/factors`));
      setErr(null);
    } catch (e: any) { setErr(e.message); }
  }
  useEffect(() => { void refresh(); }, [projectId]);

  // OAuth actions
  async function saveProvider() {
    try {
      await plutoApi(`/admin/v1/oauth/providers`, {
        method: "POST",
        body: JSON.stringify({
          project_id: projectId, ...oform,
          scopes: oform.scopes.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      pushUiHistory({ action: "oauth.provider.upsert", detail: oform.provider, ok: true });
      setOform({ ...oform, client_id: "", client_secret: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function delProvider(id: string) {
    await plutoApi(`/admin/v1/oauth/providers/${id}`, { method: "DELETE" });
    await refresh();
  }

  // MFA actions
  async function enrollTotp() {
    try {
      const r = await plutoApi<any>(`/auth/v1/mfa/enroll`, { method: "POST", body: JSON.stringify({ friendly_name: "Authenticator" }) });
      setEnroll(r);
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function verifyTotp() {
    if (!enroll) return;
    try {
      await plutoApi(`/auth/v1/mfa/verify`, { method: "POST", body: JSON.stringify({ factor_id: enroll.id, code }) });
      pushUiHistory({ action: "mfa.verify", ok: true });
      setEnroll(null); setCode("");
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }
  async function delFactor(id: string) {
    await plutoApi(`/auth/v1/mfa/factors/${id}`, { method: "DELETE" });
    await refresh();
  }

  // SAML actions
  async function saveSaml() {
    try {
      await plutoApi(`/admin/v1/saml/providers`, { method: "POST", body: JSON.stringify({ project_id: projectId, ...sform }) });
      pushUiHistory({ action: "saml.upsert", detail: sform.name, ok: true });
      setSform({ name: "", entity_id: "", sso_url: "", x509_cert: "" });
      await refresh();
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Advanced Auth</h1>
      {err && <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{err}</div>}

      <div className="flex flex-wrap gap-2 items-end">
        <label className="flex flex-col text-xs">Project ID
          <input value={projectId} onChange={(e) => setProjectId(e.target.value)}
            className="mt-1 rounded-md border bg-background px-3 py-1.5 text-sm w-[320px]" placeholder="uuid" />
        </label>
        <div className="flex gap-1 ml-4">
          {(["oauth", "mfa", "saml"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm rounded-md ${tab === t ? "bg-primary text-primary-foreground" : "border"}`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {tab === "oauth" && (
        <div className="space-y-4">
          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Add / update OAuth provider</h2>
            <div className="grid grid-cols-2 gap-2">
              <select value={oform.provider} onChange={(e) => setOform({ ...oform, provider: e.target.value as any })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm">
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <input placeholder="redirect_uri (e.g. https://.../auth/v1/oauth/google/callback)" value={oform.redirect_uri}
                onChange={(e) => setOform({ ...oform, redirect_uri: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="client_id" value={oform.client_id} onChange={(e) => setOform({ ...oform, client_id: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="client_secret" value={oform.client_secret} onChange={(e) => setOform({ ...oform, client_secret: e.target.value })}
                type="password" className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="scopes (csv)" value={oform.scopes} onChange={(e) => setOform({ ...oform, scopes: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm col-span-2" />
            </div>
            <button disabled={!projectId || !oform.client_id || !oform.client_secret} onClick={saveProvider}
              className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
              Save provider
            </button>
          </section>

          <section>
            <h2 className="text-sm font-medium mb-2">Configured providers</h2>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs"><tr><th className="text-left p-2">Provider</th><th>Client</th><th>Scopes</th><th>Sign-in URL</th><th></th></tr></thead>
                <tbody>
                  {providers.map((p) => (
                    <tr key={p.id} className="border-t">
                      <td className="p-2">{p.provider}</td>
                      <td className="font-mono text-xs">{p.client_id}</td>
                      <td className="text-xs">{(p.scopes || []).join(" ")}</td>
                      <td className="text-xs">
                        <a href={`${url}/auth/v1/oauth/${p.provider}/authorize?project_id=${projectId}`} target="_blank" rel="noreferrer" className="underline">
                          Start flow
                        </a>
                      </td>
                      <td className="p-2 text-right">
                        <button onClick={() => delProvider(p.id)} className="text-destructive text-xs underline">Delete</button>
                      </td>
                    </tr>
                  ))}
                  {providers.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-sm">None</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === "mfa" && (
        <div className="space-y-4">
          <button onClick={enrollTotp} className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2">
            Enroll TOTP authenticator
          </button>

          {enroll && (
            <section className="rounded-md border p-4 space-y-2">
              <div className="font-medium text-sm">Scan the QR / paste into your app</div>
              <div className="text-xs">Secret: <code className="bg-muted px-1 rounded">{enroll.secret}</code></div>
              <img alt="qr" src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(enroll.otpauth_url)}`} />
              <div className="flex gap-2 items-center">
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code"
                  className="rounded-md border bg-background px-3 py-1.5 text-sm w-[140px]" />
                <button onClick={verifyTotp} className="rounded-md border text-sm px-3 py-2">Verify</button>
              </div>
            </section>
          )}

          <section>
            <h2 className="text-sm font-medium mb-2">Your MFA factors</h2>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs"><tr><th className="text-left p-2">Type</th><th>Name</th><th>Status</th><th>Last used</th><th></th></tr></thead>
                <tbody>
                  {factors.map((f) => (
                    <tr key={f.id} className="border-t">
                      <td className="p-2">{f.factor_type}</td>
                      <td>{f.friendly_name}</td>
                      <td className="text-center">{f.status}</td>
                      <td className="text-xs">{f.last_used_at ? new Date(f.last_used_at).toLocaleString() : "—"}</td>
                      <td className="p-2 text-right"><button onClick={() => delFactor(f.id)} className="text-destructive text-xs underline">Delete</button></td>
                    </tr>
                  ))}
                  {factors.length === 0 && <tr><td colSpan={5} className="p-4 text-center text-muted-foreground text-sm">No factors</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {tab === "saml" && (
        <div className="space-y-4">
          <section className="rounded-md border p-4 space-y-2">
            <h2 className="text-sm font-medium">Add SAML IdP</h2>
            <div className="grid grid-cols-2 gap-2">
              <input placeholder="display name" value={sform.name} onChange={(e) => setSform({ ...sform, name: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="entity_id" value={sform.entity_id} onChange={(e) => setSform({ ...sform, entity_id: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm" />
              <input placeholder="sso_url" value={sform.sso_url} onChange={(e) => setSform({ ...sform, sso_url: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-sm col-span-2" />
              <textarea placeholder="X.509 certificate (PEM)" value={sform.x509_cert} onChange={(e) => setSform({ ...sform, x509_cert: e.target.value })}
                className="rounded-md border bg-background px-3 py-1.5 text-xs font-mono h-32 col-span-2" />
            </div>
            <button disabled={!projectId || !sform.name} onClick={saveSaml}
              className="rounded-md bg-primary text-primary-foreground text-sm px-4 py-2 disabled:opacity-50">
              Save IdP
            </button>
            <div className="text-xs text-muted-foreground mt-2">
              SP Metadata URL:{" "}
              <a className="underline" target="_blank" rel="noreferrer"
                 href={`${url}/auth/v1/saml/metadata?project_id=${projectId}`}>
                {url}/auth/v1/saml/metadata?project_id={projectId || "…"}
              </a>
            </div>
          </section>

          <section>
            <h2 className="text-sm font-medium mb-2">Configured IdPs</h2>
            <div className="rounded-md border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs"><tr><th className="text-left p-2">Name</th><th>Entity</th><th>SSO URL</th><th>Enabled</th></tr></thead>
                <tbody>
                  {saml.map((s) => (
                    <tr key={s.id} className="border-t">
                      <td className="p-2">{s.name}</td>
                      <td className="text-xs">{s.entity_id}</td>
                      <td className="text-xs">{s.sso_url}</td>
                      <td className="text-center">{s.enabled ? "✓" : "—"}</td>
                    </tr>
                  ))}
                  {saml.length === 0 && <tr><td colSpan={4} className="p-4 text-center text-muted-foreground text-sm">None</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
