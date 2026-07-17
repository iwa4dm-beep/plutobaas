import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  loadCustomDomains,
  isValidHostname,
  newDomainId,
  nextRetryDelayMs,
  parseExpectedValues,
  probeDomainSsl,
  removeCustomDomain,
  upsertCustomDomain,
  verifyDomainRecord,
  type CustomDomain,
  type CustomDomainStatus,
  type DomainRecordType,
  type SslStatus,
} from "@/lib/pluto/custom-domains-store";

const DEFAULT_TARGET_IP = "185.158.133.1";
const DEFAULT_CNAME_TARGET = "app.timescard.cloud";
const AUTO_TICK_MS = 60_000; // scheduler tick

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

const SSL_STYLES: Record<SslStatus, string> = {
  unknown: "bg-muted text-muted-foreground border-border",
  pending: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30",
  active: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  failed: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30",
};
const SSL_LABEL: Record<SslStatus, string> = {
  unknown: "SSL —",
  pending: "SSL pending",
  active: "SSL active",
  failed: "SSL failed",
};

type Props = { workspaceId: string; currentSlug?: string };

function defaultExpected(type: DomainRecordType): string {
  if (type === "A") return DEFAULT_TARGET_IP;
  if (type === "CNAME") return DEFAULT_CNAME_TARGET;
  return `pluto-verify=${Math.random().toString(36).slice(2, 12)}`;
}

export function CustomDomainsPanel({ workspaceId, currentSlug }: Props) {
  const [rows, setRows] = useState<CustomDomain[]>([]);
  const [hostname, setHostname] = useState("");
  const [slug, setSlug] = useState(currentSlug ?? "");
  const [recordType, setRecordType] = useState<DomainRecordType>("A");
  const [expectedValue, setExpectedValue] = useState(DEFAULT_TARGET_IP);
  const [busyId, setBusyId] = useState<string | null>(null);
  const runningRef = useRef(false);

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

  // Keep the default expected value in sync when the user flips record type,
  // but only if they haven't typed something custom.
  useEffect(() => {
    setExpectedValue((v) => {
      const wasDefault =
        v === DEFAULT_TARGET_IP || v === DEFAULT_CNAME_TARGET || v.startsWith("pluto-verify=") || v.trim() === "";
      return wasDefault ? defaultExpected(recordType) : v;
    });
  }, [recordType]);

  const canAdd = useMemo(
    () =>
      isValidHostname(hostname) &&
      slug.trim().length > 0 &&
      parseExpectedValues(recordType, expectedValue).length > 0,
    [hostname, slug, expectedValue, recordType],
  );

  const runVerifyAndSsl = useCallback(
    async (row: CustomDomain, opts: { silent?: boolean } = {}) => {
      const wsId = workspaceId;
      upsertCustomDomain(wsId, { ...row, status: "verifying", lastError: undefined });
      const res = await verifyDomainRecord(row.hostname, row.recordType, row.expectedValue);
      const now = new Date().toISOString();
      if (!res.ok) {
        const retryCount = (row.retryCount ?? 0) + 1;
        const next = new Date(Date.now() + nextRetryDelayMs(retryCount)).toISOString();
        upsertCustomDomain(wsId, {
          ...row,
          status: "failed",
          lastCheckedAt: now,
          lastError: res.reason,
          retryCount,
          nextRetryAt: row.autoVerify === false ? undefined : next,
        });
        if (!opts.silent) toast.error(`${row.hostname}: ${res.reason}`);
        return;
      }
      // DNS matched → issue/probe SSL. The VPS reconciler picks up verified
      // rows and issues certs; we just report whether HTTPS is already up.
      const ssl = await probeDomainSsl(row.hostname);
      upsertCustomDomain(wsId, {
        ...row,
        status: "active",
        lastCheckedAt: now,
        lastError: undefined,
        retryCount: 0,
        nextRetryAt: ssl.ok ? undefined : new Date(Date.now() + nextRetryDelayMs(0)).toISOString(),
        sslStatus: ssl.ok ? "active" : "pending",
        sslCheckedAt: now,
        sslError: ssl.ok ? undefined : ssl.error,
      });
      if (!opts.silent) {
        if (ssl.ok) toast.success(`${row.hostname} is Active with SSL`);
        else toast.success(`${row.hostname} DNS verified — SSL provisioning…`);
      }
    },
    [workspaceId],
  );

  // Scheduled auto-verification loop. Every AUTO_TICK_MS we pick rows that:
  //   - have autoVerify !== false, AND
  //   - are failed OR (active with SSL not active), AND
  //   - nextRetryAt is in the past (or unset for never-checked failures).
  useEffect(() => {
    if (typeof window === "undefined") return;
    let cancelled = false;
    const tick = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const now = Date.now();
        const list = loadCustomDomains(workspaceId);
        const due = list.filter((r) => {
          if (r.autoVerify === false) return false;
          if (r.status === "verifying" || r.status === "removing") return false;
          const needsDns = r.status !== "active";
          const needsSsl = r.status === "active" && r.sslStatus !== "active";
          if (!needsDns && !needsSsl) return false;
          const next = r.nextRetryAt ? Date.parse(r.nextRetryAt) : 0;
          return !next || next <= now;
        });
        for (const row of due) {
          if (cancelled) return;
          await runVerifyAndSsl(row, { silent: true });
        }
      } finally {
        runningRef.current = false;
      }
    };
    // fire once on mount so newly-added rows verify without waiting a minute
    void tick();
    const iv = window.setInterval(tick, AUTO_TICK_MS);
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [workspaceId, runVerifyAndSsl, rows.length]);

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
    const trimmedExpected =
      recordType === "TXT"
        ? parseExpectedValues("TXT", expectedValue).join("\n")
        : expectedValue.trim();
    const row: CustomDomain = {
      id: newDomainId(),
      hostname: h,
      slug: slug.trim(),
      recordType,
      expectedValue: trimmedExpected,
      targetIp: recordType === "A" ? trimmedExpected : undefined,
      status: "pending",
      createdAt: new Date().toISOString(),
      sslStatus: "unknown",
      autoVerify: true,
      retryCount: 0,
    };
    upsertCustomDomain(workspaceId, row);
    setHostname("");
    const count = recordType === "TXT" ? parseExpectedValues("TXT", trimmedExpected).length : 1;
    toast.success(
      `Added ${h}. Add ${count > 1 ? `any of the ${count} ${recordType} values` : `a ${recordType} record`} and Verify will run automatically.`,
    );
  };

  const handleVerify = async (row: CustomDomain) => {
    setBusyId(row.id);
    try {
      await runVerifyAndSsl(row);
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = (row: CustomDomain) => {
    if (typeof window !== "undefined" && !window.confirm(`Remove ${row.hostname}?`)) return;
    removeCustomDomain(workspaceId, row.id);
    toast.success(`Removed ${row.hostname}`);
  };

  const toggleAuto = (row: CustomDomain) => {
    const next = row.autoVerify === false;
    upsertCustomDomain(workspaceId, {
      ...row,
      autoVerify: next,
      nextRetryAt: next ? new Date(Date.now() + nextRetryDelayMs(row.retryCount ?? 0)).toISOString() : undefined,
    });
  };

  const copyDnsRecord = async (row: CustomDomain) => {
    const type = row.recordType;
    const name = type === "TXT" ? `_pluto-verify.${row.hostname}` : row.hostname;
    const values = parseExpectedValues(type, row.expectedValue);
    const valueBlock =
      type === "TXT" && values.length > 1
        ? values.map((v, i) => `Value ${i + 1}: ${v}`).join("\n") + `\n(any one of the values matches)`
        : `Value: ${values[0] ?? row.expectedValue}`;
    const text = `Type: ${type}\nName: ${name}\n${valueBlock}\nTTL: 300`;
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
            Verify with A, CNAME, or TXT records. Failed rows auto-retry with backoff;
            SSL is provisioned automatically after DNS verifies.
          </p>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length} domain{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      <div className="grid gap-3 border-b border-border px-4 py-4 sm:grid-cols-[1.6fr_1fr_0.7fr_1.2fr_auto]">
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
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Type</label>
          <select
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            value={recordType}
            onChange={(e) => setRecordType(e.target.value as DomainRecordType)}
          >
            <option value="A">A</option>
            <option value="CNAME">CNAME</option>
            <option value="TXT">TXT</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            {recordType === "A"
              ? "Target IP"
              : recordType === "CNAME"
                ? "Target hostname"
                : "TXT value(s) — one per line"}
          </label>
          {recordType === "TXT" ? (
            <textarea
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 font-mono"
              rows={3}
              placeholder={`${defaultExpected("TXT")}\npluto-verify=another-token`}
              value={expectedValue}
              onChange={(e) => setExpectedValue(e.target.value)}
            />
          ) : (
            <input
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              placeholder={defaultExpected(recordType)}
              value={expectedValue}
              onChange={(e) => setExpectedValue(e.target.value)}
            />
          )}
          {recordType === "TXT" && parseExpectedValues("TXT", expectedValue).length > 1 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              Matches if DNS returns any of the {parseExpectedValues("TXT", expectedValue).length} values.
            </p>
          )}
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
          {rows.map((row) => {
            const ssl: SslStatus = row.sslStatus ?? "unknown";
            const nextRetry = row.nextRetryAt ? new Date(row.nextRetryAt) : null;
            return (
              <li key={row.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-mono text-sm">{row.hostname}</span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLES[row.status]}`}
                      >
                        {STATUS_LABEL[row.status]}
                      </span>
                      <span
                        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${SSL_STYLES[ssl]}`}
                      >
                        {SSL_LABEL[ssl]}
                      </span>
                      <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {row.recordType}
                      </span>
                    </div>
                    {(() => {
                      const vals = parseExpectedValues(row.recordType, row.expectedValue);
                      const label =
                        vals.length > 1
                          ? `${vals[0]} +${vals.length - 1} more`
                          : vals[0] ?? row.expectedValue;
                      return (
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          slug <code className="rounded bg-muted px-1">{row.slug}</code> · {row.recordType} →{" "}
                          <code className="rounded bg-muted px-1" title={vals.join("\n")}>
                            {label}
                          </code>
                          {vals.length > 1 && (
                            <span className="ml-1 text-[10px]">(any match)</span>
                          )}
                          {row.lastCheckedAt && <> · checked {new Date(row.lastCheckedAt).toLocaleString()}</>}
                          {nextRetry && row.status !== "active" && row.autoVerify !== false && (
                            <> · next auto-retry {nextRetry.toLocaleTimeString()}</>
                          )}
                        </div>
                      );
                    })()}
                    {row.lastError && <div className="mt-1 text-xs text-red-500">DNS: {row.lastError}</div>}
                    {row.sslError && ssl !== "active" && (
                      <div className="mt-1 text-xs text-red-500">SSL: {row.sslError}</div>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        className="h-3 w-3"
                        checked={row.autoVerify !== false}
                        onChange={() => toggleAuto(row)}
                      />
                      Auto
                    </label>
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
                      {busyId === row.id ? "Verifying…" : "Verify now"}
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
            );
          })}
        </ul>
      )}
    </section>
  );
}
