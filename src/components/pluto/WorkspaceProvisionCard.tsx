// Auto-provision a Pluto workspace + admin user on the VPS.
// Shows generated email/password ONCE after success (with copy buttons).
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, Loader2, Copy, CheckCircle2, AlertTriangle, Eye, EyeOff } from "lucide-react";
import { provisionWorkspace } from "@/lib/pluto/workspace-provisioner.functions";

type Result =
  | { ok: true; workspaceId: string; adminEmail: string; adminPassword: string; userId: string }
  | { ok: false; step: string; error: string; status: number };

export function WorkspaceProvisionCard() {
  const provision = useServerFn(provisionWorkspace);
  const [projectName, setProjectName] = useState("");
  const [customEmail, setCustomEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [showPw, setShowPw] = useState(false);

  const run = async () => {
    if (!projectName.trim() || projectName.trim().length < 2) {
      toast.error("Project name অন্তত ২ অক্ষর হতে হবে");
      return;
    }
    setBusy(true); setResult(null);
    try {
      const r = await provision({
        data: {
          projectName: projectName.trim(),
          adminEmail: customEmail.trim() || undefined,
        },
      });
      setResult(r);
      if (r.ok) toast.success("Workspace + admin user তৈরি হয়েছে ✓");
      else toast.error(`Failed at ${r.step}: ${r.error}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Provision failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = (v: string, label: string) => {
    navigator.clipboard.writeText(v);
    toast.success(`${label} copied`);
  };

  return (
    <div className="rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-primary/10 p-2 text-primary">
          <Building2 className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h3 className="font-semibold">Auto-provision Workspace</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            VPS-এ নতুন workspace + admin user auto-তৈরি করে। Email/password একবারই দেখানো হবে — save করে রাখুন।
          </p>
        </div>
      </div>

      {!result?.ok && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium block mb-1">Project name *</label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="my-project"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              disabled={busy}
              maxLength={64}
            />
          </div>
          <div>
            <label className="text-xs font-medium block mb-1">Admin email (optional)</label>
            <input
              type="email"
              value={customEmail}
              onChange={(e) => setCustomEmail(e.target.value)}
              placeholder="auto-generate"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              disabled={busy}
              maxLength={255}
            />
          </div>
        </div>
      )}

      {!result?.ok && (
        <button
          onClick={run}
          disabled={busy || !projectName.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
          {busy ? "Provisioning…" : "Create workspace"}
        </button>
      )}

      {result && !result.ok && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm flex gap-2">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div>
            <div className="font-medium text-destructive">Failed at step: {result.step}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{result.error}</div>
            <div className="text-[11px] text-muted-foreground mt-1">HTTP {result.status}</div>
          </div>
        </div>
      )}

      {result?.ok && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-emerald-600">
            <CheckCircle2 className="h-4 w-4" />
            <span className="font-medium">Workspace created</span>
          </div>

          <Field label="Workspace ID" value={result.workspaceId} onCopy={copy} />
          <Field label="User ID" value={result.userId} onCopy={copy} />
          <Field label="Admin email" value={result.adminEmail} onCopy={copy} />

          <div>
            <label className="text-xs font-medium block mb-1">Admin password</label>
            <div className="flex gap-2">
              <input
                readOnly
                type={showPw ? "text" : "password"}
                value={result.adminPassword}
                className="flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm font-mono"
              />
              <button
                onClick={() => setShowPw((v) => !v)}
                className="rounded-md border border-border px-2 hover:bg-accent"
                aria-label="Toggle password visibility"
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
              <button
                onClick={() => copy(result.adminPassword, "Password")}
                className="rounded-md border border-border px-2 hover:bg-accent"
                aria-label="Copy password"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          </div>

          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs flex gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
            <span>
              এই password আর দেখানো হবে না। এখনই save/copy করুন — page refresh করলে হারিয়ে যাবে।
            </span>
          </div>

          <button
            onClick={() => { setResult(null); setProjectName(""); setCustomEmail(""); }}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Provision another workspace
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, value, onCopy }: { label: string; value: string; onCopy: (v: string, l: string) => void }) {
  return (
    <div>
      <label className="text-xs font-medium block mb-1">{label}</label>
      <div className="flex gap-2">
        <input readOnly value={value} className="flex-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs font-mono" />
        <button
          onClick={() => onCopy(value, label)}
          className="rounded-md border border-border px-2 hover:bg-accent"
          aria-label={`Copy ${label}`}
        >
          <Copy className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
