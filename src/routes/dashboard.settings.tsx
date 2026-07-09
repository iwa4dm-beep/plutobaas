import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardSettingsHelp } from "@/content/help/dashboard.settings";
import { pluto, type PlutoSettings } from "@/lib/pluto/client";
import { isLive, live } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/settings")({
  component: SettingsPage,
});

// Keys we surface on the settings page when running against a live
// backend. Everything is namespaced under `dashboard.*` so ad-hoc
// service_settings rows added by other tools don't clutter this UI.
const SETTINGS_KEYS = [
  "dashboard.backendUrl", "dashboard.smtpHost", "dashboard.smtpPort", "dashboard.smtpUser",
  "dashboard.storageDriver", "dashboard.s3Bucket", "dashboard.s3Region", "dashboard.jwtRotatedAt",
] as const;

const KEY_TO_FIELD: Record<string, keyof PlutoSettings> = {
  "dashboard.backendUrl":   "backendUrl",
  "dashboard.smtpHost":     "smtpHost",
  "dashboard.smtpPort":     "smtpPort",
  "dashboard.smtpUser":     "smtpUser",
  "dashboard.storageDriver":"storageDriver",
  "dashboard.s3Bucket":     "s3Bucket",
  "dashboard.s3Region":     "s3Region",
  "dashboard.jwtRotatedAt": "jwtRotatedAt",
};
const FIELD_TO_KEY = Object.fromEntries(Object.entries(KEY_TO_FIELD).map(([k, v]) => [v, k])) as Record<keyof PlutoSettings, string>;

async function loadLive(): Promise<PlutoSettings> {
  const { items } = await live.admin.settings.list();
  const base: PlutoSettings = await pluto.settings.get(); // defaults
  for (const it of items) {
    const f = KEY_TO_FIELD[it.key];
    if (!f) continue;
    (base as Record<string, unknown>)[f as string] = it.value as never;
  }
  return base;
}

function SettingsPage() {
  const [s, setS] = useState<PlutoSettings | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try { setS(isLive() ? await loadLive() : await pluto.settings.get()); }
      catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    })();
  }, []);

  if (err) return <div className="text-sm text-destructive">{err}</div>;
  if (!s) return <div className="text-sm text-muted-foreground">Loading…</div>;

  async function save(patch: Partial<PlutoSettings>) {
    if (!s) return;
    const next = { ...s, ...patch };
    setS(next);
    try {
      if (isLive()) {
        // Upsert one row per field so we don't clobber unrelated keys.
        for (const [f, v] of Object.entries(patch)) {
          const key = FIELD_TO_KEY[f as keyof PlutoSettings];
          if (key) await live.admin.settings.upsert({ key, value: v });
        }
      } else {
        await pluto.settings.update(patch);
      }
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }

  async function rotate() {
    if (isLive()) {
      const at = new Date().toISOString();
      await live.admin.settings.upsert({ key: "dashboard.jwtRotatedAt", value: at });
      setS({ ...s!, jwtRotatedAt: at });
    } else {
      await pluto.settings.rotateJwt();
      setS(await pluto.settings.get());
    }
  }

  return (
    <div>
      <PageHeader title="Settings" description="Backend URL, SMTP, storage driver, এবং JWT secret।" />
      <HelpPanel help={dashboardSettingsHelp} />

      <div className="space-y-6">
        <Card title="Backend">
          <Field label="Backend URL" value={s.backendUrl} onChange={(v) => save({ backendUrl: v })} />
        </Card>

        <Card title="SMTP (email)">
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Host" value={s.smtpHost} onChange={(v) => save({ smtpHost: v })} />
            <Field label="Port" value={String(s.smtpPort)} onChange={(v) => save({ smtpPort: Number(v) || 0 })} />
            <Field label="User" value={s.smtpUser} onChange={(v) => save({ smtpUser: v })} />
          </div>
        </Card>

        <Card title="Storage driver">
          <select value={s.storageDriver} onChange={(e) => save({ storageDriver: e.target.value as "local" | "s3" })} className="rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="local">local disk</option>
            <option value="s3">S3-compatible</option>
          </select>
          {s.storageDriver === "s3" && (
            <div className="mt-3 grid sm:grid-cols-2 gap-3">
              <Field label="Bucket" value={s.s3Bucket} onChange={(v) => save({ s3Bucket: v })} />
              <Field label="Region" value={s.s3Region} onChange={(v) => save({ s3Region: v })} />
            </div>
          )}
        </Card>

        <Card title="JWT secret">
          <p className="text-xs text-muted-foreground">Last rotated: {s.jwtRotatedAt ? new Date(s.jwtRotatedAt).toLocaleString() : "never"}</p>
          <button onClick={rotate} className="mt-2 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
            Rotate JWT secret
          </button>
        </Card>

        {savedAt && <p className="text-xs text-muted-foreground">Saved at {savedAt}</p>}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-5">
      <h2 className="font-medium text-sm mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />
    </div>
  );
}
