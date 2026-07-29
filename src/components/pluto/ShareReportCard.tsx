// Create a signed, expiring share link for an import job report.
import { useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { createReportShareLinkFn } from "@/lib/pluto/import-job.functions";

const TTLS: { label: string; minutes: number }[] = [
  { label: "15 minutes", minutes: 15 },
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 1440 },
  { label: "7 days", minutes: 10080 },
  { label: "30 days", minutes: 43200 },
];

export function ShareReportCard({ jobId }: { jobId: string }) {
  const [ttl, setTtl] = useState(1440);
  const [includeSql, setIncludeSql] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true);
    try {
      const r = await createReportShareLinkFn({
        data: { id: jobId, ttlMinutes: ttl, includeSql, origin: window.location.origin },
      });
      if (!r.ok || !r.url) { setErr(r.error ?? "Could not create share link"); setUrl(null); }
      else { setErr(null); setUrl(r.url); setExpiresAt(r.expiresAt); }
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function copy() {
    if (!url) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="border rounded p-2 bg-background space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium inline-flex items-center gap-1"><Link2 className="h-3.5 w-3.5" /> Share report</span>
        <span className="text-muted-foreground">— read-only signed link, expires automatically.</span>
        <div className="ml-auto flex items-center gap-2">
          <select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} className="rounded border bg-background px-1 py-0.5 text-[11px]">
            {TTLS.map((t) => <option key={t.minutes} value={t.minutes}>{t.label}</option>)}
          </select>
          <label className="inline-flex items-center gap-1 text-[11px]">
            <input type="checkbox" checked={includeSql} onChange={(e) => setIncludeSql(e.target.checked)} />
            include SQL
          </label>
          <button className="underline" disabled={busy} onClick={() => void create()}>
            {busy ? "Creating…" : "Create link"}
          </button>
        </div>
      </div>

      {err && <p className="text-[11px] text-destructive">{err}</p>}

      {url && (
        <div className="flex items-center gap-2">
          <input readOnly value={url} className="flex-1 rounded border bg-muted/40 px-2 py-1 font-mono text-[11px]" />
          <button onClick={() => void copy()} className="inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] hover:bg-muted">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy"}
          </button>
          <a href={url} target="_blank" rel="noreferrer" className="rounded border px-2 py-1 text-[11px] hover:bg-muted">Open</a>
        </div>
      )}
      {expiresAt && <p className="text-[11px] text-muted-foreground">Expires {new Date(expiresAt).toLocaleString()}.</p>}
    </div>
  );
}
