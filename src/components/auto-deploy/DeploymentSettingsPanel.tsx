// Deployment Settings panel — Phase 3 of Auto-Deploy Studio.
// Per-workspace persisted config with dirty-check + save.
import { useEffect, useMemo, useState } from "react";
import { Settings, Save, RotateCcw, CheckCircle2 } from "lucide-react";
import {
  DEFAULT_SETTINGS,
  loadDeploymentSettings,
  saveDeploymentSettings,
  validateNotifyEmail,
  type DeploymentSettings,
} from "@/lib/pluto/deployment-settings";
import { toast } from "sonner";

interface Props {
  workspaceId: string;
  onSaved?: (settings: DeploymentSettings) => void;
}

export function DeploymentSettingsPanel({ workspaceId, onSaved }: Props) {
  const [initial, setInitial] = useState<DeploymentSettings>(DEFAULT_SETTINGS);
  const [form, setForm] = useState<DeploymentSettings>(DEFAULT_SETTINGS);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const loaded = loadDeploymentSettings(workspaceId);
    setInitial(loaded);
    setForm(loaded);
  }, [workspaceId]);

  const dirty = useMemo(() => JSON.stringify(initial) !== JSON.stringify(form), [initial, form]);
  const emailErr = validateNotifyEmail(form.notifyEmail);

  function update<K extends keyof DeploymentSettings>(key: K, value: DeploymentSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleSave() {
    if (emailErr) { toast.error(emailErr); return; }
    const normalized: DeploymentSettings = {
      ...form,
      servedSiteUrl: form.servedSiteUrl.trim(),
      servedSiteUrlTemplate: form.servedSiteUrlTemplate.trim(),
      notifyEmail: form.notifyEmail.trim(),
      defaultBranch: form.defaultBranch.trim() || "main",
    };
    saveDeploymentSettings(workspaceId, normalized);
    setInitial(normalized);
    setForm(normalized);
    setSavedAt(Date.now());
    onSaved?.(normalized);
    toast.success("Deployment settings saved");
  }

  function handleReset() {
    setForm(initial);
  }

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="border-b border-border px-4 py-3 flex items-center justify-between">
        <div className="text-sm font-medium flex items-center gap-2">
          <Settings className="h-4 w-4" /> Deployment settings
          <span className="text-xs font-normal text-muted-foreground">workspace {workspaceId.slice(0, 8)}</span>
        </div>
        <div className="flex items-center gap-2">
          {savedAt && !dirty && (
            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
              <CheckCircle2 className="h-3 w-3" /> saved
            </span>
          )}
          <button
            onClick={handleReset}
            disabled={!dirty}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
          <button
            onClick={handleSave}
            disabled={!dirty || !!emailErr}
            className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Save className="h-3 w-3" /> Save
          </button>
        </div>
      </div>

      <div className="p-4 grid gap-4 md:grid-cols-2 text-xs">
        <Toggle
          label="Auto-deploy on push"
          hint="Trigger a deploy automatically when a webhook reports a push to the default branch."
          checked={form.autoDeployOnPush}
          onChange={(v) => update("autoDeployOnPush", v)}
        />
        <Toggle
          label="Strict served-site check"
          hint="Fail the pipeline when the served-site probe returns non-2xx (default: warning only)."
          checked={form.strictServedSite}
          onChange={(v) => update("strictServedSite", v)}
        />
        <Toggle
          label="Strict SSL"
          hint="Fail the pipeline when SSL/HTTPS verification reports an invalid certificate."
          checked={form.strictSsl}
          onChange={(v) => update("strictSsl", v)}
        />
        <Field
          label="Default branch"
          hint="Used as the default git ref when importing a GitHub repo."
          value={form.defaultBranch}
          onChange={(v) => update("defaultBranch", v)}
          placeholder="main"
        />
        <Field
          label="Served-site URL override"
          hint="Exact URL probed after unpack. Leave blank to auto-detect from the sandbox worker."
          value={form.servedSiteUrl}
          onChange={(v) => update("servedSiteUrl", v)}
          placeholder="https://app.timescard.app"
          full
        />
        <Field
          label="Served-site URL template"
          hint="Pattern with {slug} placeholder. Applied when no explicit URL is set."
          value={form.servedSiteUrlTemplate}
          onChange={(v) => update("servedSiteUrlTemplate", v)}
          placeholder="https://{slug}.app.timescard.app"
          full
        />
        <div className="md:col-span-2">
          <Field
            label="Notification email"
            hint="Send deploy status alerts to this address (optional)."
            value={form.notifyEmail}
            onChange={(v) => update("notifyEmail", v)}
            placeholder="ops@example.com"
            full
            error={emailErr ?? undefined}
          />
        </div>
      </div>
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 cursor-pointer rounded-md border border-border/60 bg-muted/20 px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-3.5 w-3.5"
      />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{label}</div>
        <div className="text-muted-foreground text-[11px] leading-snug">{hint}</div>
      </div>
    </label>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  placeholder,
  full,
  error,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  full?: boolean;
  error?: string;
}) {
  return (
    <div className={full ? "md:col-span-2" : ""}>
      <div className="font-medium mb-1">{label}</div>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-md border bg-background px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-ring ${error ? "border-destructive" : "border-border"}`}
      />
      <div className={`mt-1 text-[11px] ${error ? "text-destructive" : "text-muted-foreground"}`}>
        {error ?? hint}
      </div>
    </div>
  );
}
