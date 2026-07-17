import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  loadCustomDomains,
  isValidHostname,
  newDomainId,
  removeCustomDomain,
  upsertCustomDomain,
  verifyDomainDns,
  type CustomDomain,
  type CustomDomainStatus,
} from "@/lib/pluto/custom-domains-store";

const DEFAULT_TARGET_IP = "185.158.133.1";

const STATUS_STYLES: Record<CustomDomainStatus, string> = {
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  verifying: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30",
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
  removing: "bg-muted text-muted-foreground border-border",
};

const STATUS_LABEL: Record<CustomDomainStatus, string> = {
  pending: "Pending DNS",
  verifying: "Verifying",
  active: "Active",
  failed: "Failed",
  removing: "Removing",
};

type Props = { workspaceId: string; currentSlug?: string };

export function CustomDomainsPanel({ workspaceId, currentSlug }: Props) {
  const [rows, setRows] = useState<CustomDomain[]>([]);
  const [hostname, setHostname] = useState("");
  const [slug, setSlug] = useState(currentSlug ?? "");
  const [targetIp, setTargetIp] = useState(DEFAULT_TARGET_IP);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(() => setRows(loadCustomDomains(workspaceId)), [workspaceId]);

  useEffect(() => {
    refresh();
    if (typeof window === "undefined") return;
    const handler = () => refresh();
    window.addEventListener("pluto:custom-domains:changed", handler);
    return () => window.removeEventListener("pluto:custom-domains:changed", handler);
  }, [refresh]);

  useEffect(() => {
    if (currentSlug && !slug) setSlug(currentSlug);
  }, [currentSlug, slug]);

  const canAdd = useMemo(
    () => isValidHostname(hostname) && slug.trim().length > 0 && targetIp.trim().length > 0,
    [hostname, slug, targetIp],
  );

  const handleAdd = () => {
    const h = hostname.trim().toLowerCase();
    if (!isValidHostname(h)) {
      toast.error("Invalid hostname");
      return;
    }
    if (rows.some((r) => r.hostname === h)) {
      toast.error("Hostname already added");
      return;
    }
    const row: CustomDomain = {
      id: newDomainId(),
      hostname: h,
      slug: slug.trim(),
      targetIp: targetIp.trim(),
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    upsertCustomDomain(workspaceId, row);
    setHostname("");
    toast.success(`Added ${h}. Add an A record → ${row.targetIp} at your DNS provider, then click Verify.`);
  };

  const handleVerify = async (row: CustomDomain) => {
    setBusyId(row.id);
    upsertCustomDomain(workspaceId, { ...row, status: "verifying", lastError: undefined });
    const res = await verifyDomainDns(row.hostname, row.targetIp);
    const now = new Date().toISOString();
    if (res.ok) {
      upsertCustomDomain(workspaceId, { ...row, status: "active", lastCheckedAt: now, lastError: undefined });
      toast.success(`${row.hostname} is Active`);
    } else {
      upsertCustomDomain(workspaceId, { ...row, status: "failed", lastCheckedAt: now, lastError: res.reason });
      toast.error(`${row.hostname}: ${res.reason}`);
    }
    setBusyId(null);
  };

  const handleRemove = (row: CustomDomain) => {
    if (typeof window !== "undefined" && !window.confirm(`Remove ${row.hostname}?`)) return;
    removeCustomDomain(workspaceId, row.id);
    toast.success(`Removed ${row.hostname}`);
  };

  const copyDnsRecord = async (row: CustomDomain) => {
    const text = `Type: A\nName: ${row.hostname}\nValue: ${row.targetIp}\nTTL: 300`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success("DNS record copied to clipboard");
    } catch {
      toast.error("Could not copy — copy manually from the details row.");
    }
  };

  return (
    <section className="rounded-xl border border-border bg-card">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold">Custom domains</h3>
          <p className="text-xs text-muted-foreground">
            Map user-supplied hostnames to a slug. Point an A record at{" "}
            <code className="rounded bg-muted px-1">{DEFAULT_TARGET_IP}</code>, then verify.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">{rows.length} domain{rows.length === 1 ? "" : "s"}</span>
      </header>

      <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-[2fr_1fr_1fr_auto]">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Hostname</label>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="app.example.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Slug</label>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="my-project-abc123"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Target IP</label>
          <input
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder={DEFAULT_TARGET_IP}
            value={targetIp}
            onChange={(e) => setTargetIp(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <button
            type="button"
            disabled={!canAdd}
            onClick={handleAdd}
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            Add domain
          </button>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          No custom domains yet. Add one above to route a hostname to this project.
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{row.hostname}</span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[row.status]}`}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    slug <code className="rounded bg-muted px-1">{row.slug}</code> · A → {row.targetIp}
                    {row.lastCheckedAt && (
                      <> · checked {new Date(row.lastCheckedAt).toLocaleString()}</>
                    )}
                  </div>
                  {row.lastError && (
                    <div className="mt-1 text-xs text-red-500">{row.lastError}</div>
                  )}
                </div>
                <div className="flex flex-shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => copyDnsRecord(row)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                  >
                    Copy DNS
                  </button>
                  <button
                    type="button"
                    disabled={busyId === row.id}
                    onClick={() => handleVerify(row)}
                    className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                  >
                    {busyId === row.id ? "Verifying…" : "Verify"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemove(row)}
                    className="rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1 text-xs text-red-600 hover:bg-red-500/20 dark:text-red-400"
                  >
                    Remove
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
