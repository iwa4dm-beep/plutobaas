import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Copy, Check, ArrowRight, KeyRound, Globe, Play } from "lucide-react";
import { live, type SignupFullResult } from "@/lib/pluto/live";

export const Route = createFileRoute("/onboarding")({
  head: () => ({ meta: [{ title: "Welcome — Pluto onboarding" }] }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<SignupFullResult | null>(null);
  const [step, setStep] = useState(1);
  const [domain, setDomain] = useState("");
  const [added, setAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const raw = sessionStorage.getItem("pluto:onboarding");
    if (!raw) { navigate({ to: "/dashboard" }); return; }
    setData(JSON.parse(raw));
  }, [navigate]);

  if (!data) return null;
  const apiUrl = import.meta.env.VITE_PLUTO_URL || window.location.origin;

  async function addDomain() {
    if (!domain.trim() || !data) return;
    setBusy(true); setErr(null);
    try {
      await live.admin.domains.add(data.project.id, domain.trim());
      setAdded(true);
      setStep(3);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  function finish() {
    sessionStorage.removeItem("pluto:onboarding");
    navigate({ to: "/dashboard" });
  }

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-semibold">Welcome to {data.workspace.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">Three quick steps to go live.</p>
        </div>

        <ol className="flex items-center gap-2 mb-8 text-xs">
          {["Keys", "Website", "Test"].map((label, i) => (
            <li key={label} className={`flex-1 rounded-full px-3 py-1.5 text-center border ${step > i ? "bg-primary text-primary-foreground border-primary" : step === i + 1 ? "border-primary text-primary" : "border-muted text-muted-foreground"}`}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 1 && (
          <Card icon={<KeyRound className="h-5 w-5" />} title="Your API keys" desc="Save these now — the service_role key will not be shown again.">
            <KeyRow label="Publishable key (browser-safe)" value={data.keys.anon} />
            <KeyRow label="Service-role key (server only — keep secret)" value={data.keys.service_role} secret />
            <button onClick={() => setStep(2)} className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
              I saved them <ArrowRight className="h-4 w-4" />
            </button>
          </Card>
        )}

        {step === 2 && (
          <Card icon={<Globe className="h-5 w-5" />} title="Add your website" desc="The domain you enter here will be allowed to call your API from a browser.">
            {data.cors_added ? (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                ✅ Your signup domain is already added. You can add more later in Dashboard → Domains.
                <button onClick={() => setStep(3)} className="mt-3 block text-primary text-sm font-medium">Continue →</button>
              </div>
            ) : (
              <>
                <input value={domain} onChange={(e) => setDomain(e.target.value)}
                  placeholder="https://app.example.com"
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm mb-3" />
                {err && <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{err}</div>}
                <div className="flex gap-2">
                  <button onClick={addDomain} disabled={busy || !domain.trim()}
                    className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
                    {busy ? "Adding…" : added ? "Added ✓" : "Add & continue"}
                  </button>
                  <button onClick={() => setStep(3)} className="rounded-md border px-4 py-2 text-sm">Skip</button>
                </div>
              </>
            )}
          </Card>
        )}

        {step === 3 && (
          <Card icon={<Play className="h-5 w-5" />} title="Try the SDK" desc="Copy-paste this into a terminal or your app.">
            <CodeBlock code={`curl ${apiUrl}/rest/v1/customers?limit=3 \\
  -H "apikey: ${data.keys.anon}"`} />
            {data.demo_schema && (
              <p className="mt-3 text-xs text-muted-foreground">
                Demo tables are live in schema <code className="rounded bg-muted px-1">{data.demo_schema}</code> — 5 customers + orders ready to query.
              </p>
            )}
            <button onClick={finish} className="mt-5 inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">
              Go to dashboard <ArrowRight className="h-4 w-4" />
            </button>
          </Card>
        )}
      </div>
    </div>
  );
}

function Card({ icon, title, desc, children }: {
  icon: React.ReactNode; title: string; desc: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-center gap-2 mb-1">{icon}<h2 className="text-lg font-medium">{title}</h2></div>
      <p className="text-sm text-muted-foreground mb-4">{desc}</p>
      {children}
    </div>
  );
}

function KeyRow({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(!secret);
  return (
    <div className="mb-3">
      <div className="text-xs text-muted-foreground mb-1">{label}</div>
      <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 font-mono text-xs">
        <span className="flex-1 truncate">{reveal ? value : "•".repeat(48)}</span>
        {secret && (
          <button onClick={() => setReveal((r) => !r)} className="text-muted-foreground hover:text-foreground">
            {reveal ? "hide" : "show"}
          </button>
        )}
        <button onClick={() => { navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
          className="text-muted-foreground hover:text-foreground">
          {copied ? <Check className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative rounded-md border bg-muted/40 p-3">
      <pre className="overflow-x-auto text-xs"><code>{code}</code></pre>
      <button onClick={() => { navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="absolute right-2 top-2 rounded p-1 hover:bg-background">
        {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
