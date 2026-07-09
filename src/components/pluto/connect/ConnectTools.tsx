import { useCallback, useRef, useState } from "react";
import {
  Check, Copy, Download, Loader2, Play, Radio, ShieldCheck,
  Database as DBIcon, HardDrive, Save, AlertCircle, FileJson, FileCode,
} from "lucide-react";
import { CONSOLIDATED_SCHEMA_SQL, splitSqlStatements, summariseStatement } from "@/lib/pluto/connect-schema";
import {
  retryWithBackoff, buildReport, downloadReportJson, downloadReportHtml,
  type ReportStep, type RetryConfig,
} from "@/lib/pluto/connect-utils";

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

type Status = "idle" | "running" | "ok" | "fail" | "skipped";

function StatusDot({ s }: { s: Status }) {
  const cls =
    s === "ok" ? "bg-green-500" :
    s === "fail" ? "bg-red-500" :
    s === "running" ? "bg-blue-500 animate-pulse" :
    s === "skipped" ? "bg-muted-foreground/40" :
    "bg-muted-foreground/30";
  return <span className={`inline-block h-2 w-2 rounded-full ${cls}`} />;
}

function wsUrlFrom(apiBase: string): string {
  return apiBase.replace(/^http/i, "ws") + "/v1/realtime";
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: unknown; ms: number }> {
  const start = performance.now();
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { ok: r.ok, status: r.status, body, ms: Math.round(performance.now() - start) };
  } catch (e) {
    return { ok: false, status: 0, body: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - start) };
  }
}

/* -------------------------------------------------------------------------- */
/* SQL toolbar — copy + download                                              */
/* -------------------------------------------------------------------------- */

export function SqlToolbar() {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(CONSOLIDATED_SCHEMA_SQL);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const download = () => {
    const blob = new Blob([CONSOLIDATED_SCHEMA_SQL], { type: "text/sql;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "pluto-baseline-schema.sql";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button onClick={copy}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-xs hover:bg-accent">
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? "Copied" : "Copy full SQL"}
      </button>
      <button onClick={download}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-card/60 px-3 py-1.5 text-xs hover:bg-accent">
        <Download className="h-3.5 w-3.5" />
        Download .sql
      </button>
      <span className="text-[11px] text-muted-foreground">
        schema + RLS/policies + triggers · একটি consolidated ফাইল
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Migration runner                                                           */
/* -------------------------------------------------------------------------- */

type StmtState = { sql: string; status: Status; ms?: number; error?: string };

export function MigrationRunner({ apiBase }: { apiBase: string }) {
  const [serviceKey, setServiceKey] = useState("");
  const [items, setItems] = useState<StmtState[]>(() =>
    splitSqlStatements(CONSOLIDATED_SCHEMA_SQL).map((sql) => ({ sql, status: "idle" as Status }))
  );
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const abortRef = useRef(false);

  const run = useCallback(async () => {
    if (!serviceKey.startsWith("sk_service_")) {
      setSummary("Service role key looks wrong — expected sk_service_…");
      return;
    }
    setRunning(true); setSummary(null); abortRef.current = false;
    const next: StmtState[] = items.map((it) => ({ sql: it.sql, status: "idle" }));
    setItems(next);

    let ok = 0, fail = 0;
    for (let i = 0; i < next.length; i++) {
      if (abortRef.current) { next[i].status = "skipped"; continue; }
      next[i] = { ...next[i], status: "running" };
      setItems([...next]);
      const res = await jsonFetch(`${apiBase}/v1/admin/sql`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "apikey": serviceKey,
          "authorization": `Bearer ${serviceKey}`,
        },
        body: JSON.stringify({ sql: next[i].sql }),
      });
      if (res.ok) { next[i] = { ...next[i], status: "ok", ms: res.ms }; ok++; }
      else {
        const msg = typeof res.body === "string" ? res.body
          : (res.body as { error?: string; message?: string })?.error
          ?? (res.body as { message?: string })?.message
          ?? JSON.stringify(res.body);
        next[i] = { ...next[i], status: "fail", ms: res.ms, error: `HTTP ${res.status} — ${String(msg).slice(0, 240)}` };
        fail++;
      }
      setItems([...next]);
    }
    setRunning(false);
    setSummary(`Applied ${ok} / ${next.length} statements${fail ? ` · ${fail} failed` : ""}`);
  }, [apiBase, items, serviceKey]);

  const stop = () => { abortRef.current = true; };

  const okCount = items.filter((i) => i.status === "ok").length;
  const failCount = items.filter((i) => i.status === "fail").length;

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          placeholder="sk_service_… (service role key)"
          value={serviceKey}
          onChange={(e) => setServiceKey(e.target.value)}
          className="min-w-[280px] flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono"
        />
        {!running ? (
          <button onClick={run} disabled={!serviceKey}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
            <Play className="h-3.5 w-3.5" /> Apply migration
          </button>
        ) : (
          <button onClick={stop}
            className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground hover:opacity-90">
            Stop
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        Service key শুধু browser memory-তে থাকে — কোথাও persist হয় না। Idempotent: বারবার run নিরাপদ।
      </p>

      <div className="mt-3 flex items-center gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5"><StatusDot s="ok" /> {okCount} ok</span>
        <span className="inline-flex items-center gap-1.5"><StatusDot s="fail" /> {failCount} failed</span>
        <span className="text-muted-foreground">{items.length} statements</span>
      </div>

      <ol className="mt-3 max-h-72 space-y-1 overflow-auto pr-1">
        {items.map((it, idx) => (
          <li key={idx} className="rounded border border-border/50 bg-background/60 p-2 text-[11px]">
            <div className="flex items-center gap-2">
              <StatusDot s={it.status} />
              <span className="font-mono text-muted-foreground">#{idx + 1}</span>
              <span className="truncate font-mono">{summariseStatement(it.sql)}</span>
              {typeof it.ms === "number" && <span className="ml-auto text-muted-foreground">{it.ms}ms</span>}
            </div>
            {it.error && <div className="mt-1 whitespace-pre-wrap break-all font-mono text-red-600 dark:text-red-400">{it.error}</div>}
          </li>
        ))}
      </ol>

      {summary && (
        <div className={`mt-2 rounded-md border p-2 text-xs ${failCount ? "border-red-500/40 bg-red-500/5" : "border-green-500/40 bg-green-500/5"}`}>
          {summary}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Realtime channel verifier — WS connectivity + subscription confirmation    */
/* -------------------------------------------------------------------------- */

type ChanState = { name: string; status: Status; note?: string; attempts?: number };
type RtEvent = { at: string; kind: "open" | "close" | "error" | "message" | "timeout" | "retry" | "subscribe"; message: string };

export function RealtimeVerifier({ apiBase }: { apiBase: string }) {
  const [anonKey, setAnonKey] = useState("");
  const [channelsInput, setChannelsInput] = useState("system:health,realtime:public:todos");
  const [maxRetries, setMaxRetries] = useState(2);
  const [wsStatus, setWsStatus] = useState<Status>("idle");
  const [wsNote, setWsNote] = useState<string>("");
  const [wsAttempts, setWsAttempts] = useState<number>(0);
  const [chans, setChans] = useState<ChanState[]>([]);
  const [events, setEvents] = useState<RtEvent[]>([]);
  const [running, setRunning] = useState(false);

  const pushEvent = (kind: RtEvent["kind"], message: string) =>
    setEvents((prev) => [...prev.slice(-199), { at: new Date().toISOString(), kind, message }]);

  const attemptOnce = useCallback((wsUrl: string, names: string[]): Promise<{ ok: boolean; chans: ChanState[]; err?: string }> => {
    return new Promise((resolve) => {
      let ws: WebSocket;
      const chanState: ChanState[] = names.map((name) => ({ name, status: "running", note: "pending" }));
      try { ws = new WebSocket(wsUrl); }
      catch (e) {
        pushEvent("error", e instanceof Error ? e.message : String(e));
        resolve({ ok: false, chans: chanState, err: e instanceof Error ? e.message : String(e) });
        return;
      }
      const timeout = setTimeout(() => {
        pushEvent("timeout", "WebSocket upgrade did not complete within 8s");
        try { ws.close(); } catch { /* ignore */ }
        resolve({ ok: false, chans: chanState, err: "timeout" });
      }, 8000);

      ws.onopen = () => {
        pushEvent("open", `Connected to ${wsUrl}`);
        names.forEach((name, idx) => {
          try {
            ws.send(JSON.stringify({ type: "subscribe", channel: name, ref: String(idx + 1) }));
            pushEvent("subscribe", `→ ${name}`);
            chanState[idx] = { ...chanState[idx], note: "subscribe sent" };
          } catch (e) {
            chanState[idx] = { ...chanState[idx], status: "fail", note: e instanceof Error ? e.message : String(e) };
          }
        });
        setChans([...chanState]);
        // wait 3s for per-channel replies, then resolve
        setTimeout(() => {
          for (let i = 0; i < chanState.length; i++) {
            if (chanState[i].status === "running") chanState[i] = { ...chanState[i], status: "ok", note: (chanState[i].note ?? "") + " · no error within 3s" };
          }
          try { ws.close(); } catch { /* ignore */ }
          clearTimeout(timeout);
          const anyFail = chanState.some((c) => c.status === "fail");
          resolve({ ok: !anyFail, chans: chanState });
        }, 3000);
      };
      ws.onmessage = (ev) => {
        pushEvent("message", String(ev.data).slice(0, 240));
        try {
          const msg = JSON.parse(String(ev.data));
          const name = msg.channel ?? msg.topic;
          if (!name) return;
          const idx = chanState.findIndex((c) => c.name === name);
          if (idx >= 0) {
            chanState[idx] = { ...chanState[idx], status: msg.error ? "fail" : "ok", note: msg.error ? String(msg.error) : msg.status ?? "subscribed" };
            setChans([...chanState]);
          }
        } catch { /* ignore non-json */ }
      };
      ws.onerror = () => {
        pushEvent("error", "WebSocket error — check CORS / TLS / firewall");
        clearTimeout(timeout);
        resolve({ ok: false, chans: chanState, err: "ws error" });
      };
      ws.onclose = (ev) => {
        pushEvent("close", `code ${ev.code}${ev.reason ? ` · ${ev.reason}` : ""}`);
      };
    });
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setEvents([]);
    setWsStatus("running"); setWsNote(""); setChans([]); setWsAttempts(0);
    const wsUrl = wsUrlFrom(apiBase) + (anonKey ? `?apikey=${encodeURIComponent(anonKey)}` : "");
    const names = channelsInput.split(",").map((s) => s.trim()).filter(Boolean);
    const initial: ChanState[] = names.map((name) => ({ name, status: "idle" }));
    setChans(initial);

    const cfg: RetryConfig = { maxRetries: Math.max(0, maxRetries), baseDelayMs: 500, maxDelayMs: 8000 };
    const result = await retryWithBackoff(
      async (attempt) => {
        if (attempt > 0) pushEvent("retry", `attempt #${attempt + 1}`);
        setWsAttempts(attempt + 1);
        const r = await attemptOnce(wsUrl, names);
        return { ok: r.ok, value: r };
      },
      cfg,
    );
    setChans(result.value.chans);
    if (result.ok) { setWsStatus("ok"); setWsNote(`Connected · ${result.attempts} attempt(s)`); }
    else { setWsStatus("fail"); setWsNote(`Failed after ${result.attempts} attempt(s)${result.value.err ? ` — ${result.value.err}` : ""}`); }
    setRunning(false);
  }, [apiBase, anonKey, channelsInput, maxRetries, attemptOnce]);

  const doExport = (kind: "json" | "html") => {
    const steps: ReportStep[] = [
      { key: "ws", label: `WebSocket ${wsUrlFrom(apiBase)}`, status: wsStatus === "ok" ? "ok" : wsStatus === "fail" ? "fail" : "idle", detail: wsNote, attempts: wsAttempts },
      ...chans.map((c) => ({
        key: `chan:${c.name}`, label: `channel ${c.name}`,
        status: c.status as ReportStep["status"], detail: c.note,
      })),
    ];
    const report = buildReport({
      tool: "realtime-verifier", apiBase, steps,
      events: events.map((e) => ({ at: e.at, kind: e.kind, message: e.message })),
    });
    (kind === "json" ? downloadReportJson : downloadReportHtml)(report);
  };

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          placeholder="pk_anon_… (optional — required for authed channels)"
          value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          className="min-w-[240px] flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono"
        />
        <input
          type="text"
          placeholder="comma-separated channel names"
          value={channelsInput}
          onChange={(e) => setChannelsInput(e.target.value)}
          className="min-w-[280px] flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono"
        />
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Max retries
          <input type="number" min={0} max={8} value={maxRetries}
            onChange={(e) => setMaxRetries(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
            className="w-14 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-mono"
          />
        </label>
        <button onClick={run} disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
          Verify
        </button>
        <button onClick={() => doExport("json")} disabled={running || events.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <FileJson className="h-3.5 w-3.5" /> JSON
        </button>
        <button onClick={() => doExport("html")} disabled={running || events.length === 0}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <FileCode className="h-3.5 w-3.5" /> HTML
        </button>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="space-y-1 text-xs">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Subscriptions</div>
          <div className="flex items-center gap-2">
            <StatusDot s={wsStatus} />
            <span className="font-mono">{wsUrlFrom(apiBase)}</span>
            {wsAttempts > 0 && <span className="text-[10px] text-muted-foreground">· {wsAttempts} attempt(s)</span>}
          </div>
          {wsNote && <div className="pl-4 text-muted-foreground">— {wsNote}</div>}
          {chans.map((c) => (
            <div key={c.name} className="flex items-center gap-2 pl-4">
              <StatusDot s={c.status} />
              <span className="font-mono">{c.name}</span>
              {c.note && <span className="text-muted-foreground">— {c.note}</span>}
            </div>
          ))}
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Channel inspector · live events</div>
          <div className="mt-1 h-56 overflow-auto rounded border border-border/50 bg-background/60 p-2 text-[11px] font-mono">
            {events.length === 0 ? (
              <div className="text-muted-foreground">No events yet — run the verifier.</div>
            ) : events.map((e, i) => {
              const color = e.kind === "error" || e.kind === "timeout" ? "text-red-600 dark:text-red-400"
                : e.kind === "open" || e.kind === "message" ? "text-green-600 dark:text-green-400"
                : e.kind === "retry" ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground";
              return (
                <div key={i} className="flex gap-2">
                  <span className="shrink-0 text-muted-foreground">{e.at.slice(11, 23)}</span>
                  <span className={`shrink-0 font-semibold ${color}`}>{e.kind}</span>
                  <span className="min-w-0 break-all">{e.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connection tester — hits apiBase, auth, realtime, storage                  */
/* -------------------------------------------------------------------------- */

type Check = { key: string; label: string; status: Status; detail?: string; ms?: number };

export function ConnectionTester({ apiBase }: { apiBase: string }) {
  const [anonKey, setAnonKey] = useState("");
  const [checks, setChecks] = useState<Check[]>([
    { key: "api",      label: "API health (/v1/health)", status: "idle" },
    { key: "auth",     label: "Auth settings (/v1/auth/settings)", status: "idle" },
    { key: "realtime", label: "Realtime WebSocket (/v1/realtime)", status: "idle" },
    { key: "storage",  label: "Storage buckets (/v1/storage/buckets)", status: "idle" },
  ]);
  const [running, setRunning] = useState(false);

  const set = (key: string, patch: Partial<Check>) =>
    setChecks((prev) => prev.map((c) => c.key === key ? { ...c, ...patch } : c));

  const run = useCallback(async () => {
    setRunning(true);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "running", detail: undefined, ms: undefined })));
    const headers: Record<string, string> = anonKey ? { apikey: anonKey, authorization: `Bearer ${anonKey}` } : {};

    // 1) API
    const api = await jsonFetch(`${apiBase}/v1/health`);
    set("api", { status: api.ok ? "ok" : "fail", ms: api.ms,
      detail: api.ok ? `HTTP ${api.status}` : `HTTP ${api.status} — ${String(typeof api.body === "string" ? api.body : JSON.stringify(api.body)).slice(0, 200)}` });

    // 2) Auth
    const auth = await jsonFetch(`${apiBase}/v1/auth/settings`, { headers });
    set("auth", { status: auth.ok ? "ok" : "fail", ms: auth.ms,
      detail: auth.ok ? "Auth service reachable" : `HTTP ${auth.status} — ${String(typeof auth.body === "string" ? auth.body : JSON.stringify(auth.body)).slice(0, 200)}` });

    // 3) Realtime WS
    await new Promise<void>((resolve) => {
      const url = wsUrlFrom(apiBase) + (anonKey ? `?apikey=${encodeURIComponent(anonKey)}` : "");
      const start = performance.now();
      let ws: WebSocket;
      try { ws = new WebSocket(url); }
      catch (e) { set("realtime", { status: "fail", detail: e instanceof Error ? e.message : String(e) }); resolve(); return; }
      const t = setTimeout(() => {
        set("realtime", { status: "fail", detail: "Timeout — no upgrade in 6s" });
        try { ws.close(); } catch { /* ignore */ }
        resolve();
      }, 6000);
      ws.onopen = () => {
        set("realtime", { status: "ok", ms: Math.round(performance.now() - start), detail: "WebSocket opened" });
        clearTimeout(t);
        try { ws.close(); } catch { /* ignore */ }
        resolve();
      };
      ws.onerror = () => {
        set("realtime", { status: "fail", detail: "WebSocket error (CORS / TLS / firewall)" });
        clearTimeout(t); resolve();
      };
    });

    // 4) Storage
    const st = await jsonFetch(`${apiBase}/v1/storage/buckets`, { headers });
    set("storage", { status: st.ok ? "ok" : "fail", ms: st.ms,
      detail: st.ok
        ? (Array.isArray(st.body) ? `${st.body.length} buckets` : "Storage reachable")
        : `HTTP ${st.status} — ${String(typeof st.body === "string" ? st.body : JSON.stringify(st.body)).slice(0, 200)}` });

    setRunning(false);
  }, [apiBase, anonKey]);

  const icons: Record<string, typeof ShieldCheck> = {
    api: DBIcon, auth: ShieldCheck, realtime: Radio, storage: HardDrive,
  };

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          placeholder="pk_anon_… (recommended)"
          value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          className="min-w-[240px] flex-1 rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono"
        />
        <button onClick={run} disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run all checks
        </button>
        <span className="text-[11px] text-muted-foreground">apiBase: <span className="font-mono">{apiBase}</span></span>
      </div>

      <ul className="mt-3 space-y-1 text-xs">
        {checks.map((c) => {
          const Icon = icons[c.key] ?? ShieldCheck;
          return (
            <li key={c.key} className="flex items-start gap-2 rounded border border-border/50 bg-background/60 p-2">
              <StatusDot s={c.status} />
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.label}</span>
                  {typeof c.ms === "number" && <span className="ml-auto text-muted-foreground">{c.ms}ms</span>}
                </div>
                {c.detail && <div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{c.detail}</div>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* End-to-end flow — auth, storage upload/download, backups, realtime         */
/* -------------------------------------------------------------------------- */

type Step = { key: string; label: string; status: Status; detail?: string; ms?: number; attempts?: number };

const initialE2E: Step[] = [
  { key: "signin",   label: "1. Sign in (email/password)",           status: "idle" },
  { key: "upload",   label: "2. Upload a test file to 'avatars'",    status: "idle" },
  { key: "download", label: "3. Download the file back and verify",  status: "idle" },
  { key: "backups",  label: "4. List backups (/v1/admin/backups)",   status: "idle" },
  { key: "rt-sub",   label: "5. Subscribe to realtime:public:todos", status: "idle" },
  { key: "rt-emit",  label: "6. Insert a todo → receive event",      status: "idle" },
  { key: "cleanup",  label: "7. Cleanup (delete file + todo)",       status: "idle" },
];

export function E2ETestRunner({ apiBase }: { apiBase: string }) {
  const [anonKey, setAnonKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [maxRetries, setMaxRetries] = useState(2);
  const [steps, setSteps] = useState<Step[]>(initialE2E);
  const [running, setRunning] = useState(false);

  const setStep = (key: string, patch: Partial<Step>) =>
    setSteps((prev) => prev.map((s) => s.key === key ? { ...s, ...patch } : s));

  const run = useCallback(async () => {
    if (!anonKey || !email || !password) return;
    setRunning(true);
    setSteps(initialE2E.map((s) => ({ ...s, status: "idle" as Status, detail: undefined, ms: undefined, attempts: undefined })));

    const cfg: RetryConfig = { maxRetries: Math.max(0, maxRetries), baseDelayMs: 500, maxDelayMs: 6000 };
    const authed = (token: string): Record<string, string> => ({
      "content-type": "application/json", apikey: anonKey, authorization: `Bearer ${token}`,
    });

    // Generic step runner with backoff. `probe` returns { ok, ...data }.
    async function runStep<T>(
      key: string,
      probe: () => Promise<{ ok: boolean; value: T; detail?: string; skip?: boolean }>,
    ): Promise<{ ok: boolean; value: T }> {
      setStep(key, { status: "running", detail: undefined, ms: undefined, attempts: 0 });
      const start = performance.now();
      const r = await retryWithBackoff(
        async (attempt) => {
          setStep(key, { attempts: attempt + 1, detail: attempt > 0 ? `retry #${attempt}` : undefined });
          const p = await probe();
          return { ok: p.ok, value: p };
        },
        cfg,
      );
      const ms = Math.round(performance.now() - start);
      if (r.value.skip) setStep(key, { status: "skipped", detail: r.value.detail, ms, attempts: r.attempts });
      else if (r.ok)    setStep(key, { status: "ok",       detail: r.value.detail, ms, attempts: r.attempts });
      else              setStep(key, { status: "fail",     detail: r.value.detail, ms, attempts: r.attempts });
      return { ok: r.ok, value: r.value.value };
    }

    // 1) sign in
    const signin = await runStep<{ token?: string; userId?: string }>("signin", async () => {
      const s = await jsonFetch(`${apiBase}/v1/auth/token?grant_type=password`, {
        method: "POST", headers: { "content-type": "application/json", apikey: anonKey },
        body: JSON.stringify({ email, password }),
      });
      const b = s.body as { access_token?: string; user?: { id: string }; error?: string; msg?: string };
      if (s.ok && b?.access_token) return { ok: true, value: { token: b.access_token, userId: b.user?.id ?? "unknown" }, detail: `user ${b.user?.id ?? "?"}` };
      return { ok: false, value: {}, detail: `HTTP ${s.status} — ${b?.error ?? b?.msg ?? "no access_token"}` };
    });
    if (!signin.ok || !signin.value.token) { setRunning(false); return; }
    const token = signin.value.token;
    const userId = signin.value.userId!;

    // 2) upload
    const testName = `${userId}/e2e-${Date.now()}.txt`;
    const testBody = `pluto e2e ${new Date().toISOString()}`;
    const up = await runStep<null>("upload", async () => {
      const r = await jsonFetch(`${apiBase}/v1/storage/object/avatars/${encodeURIComponent(testName)}`, {
        method: "POST",
        headers: { apikey: anonKey, authorization: `Bearer ${token}`, "content-type": "text/plain" },
        body: testBody,
      });
      return r.ok
        ? { ok: true, value: null, detail: testName }
        : { ok: false, value: null, detail: `HTTP ${r.status} — ${JSON.stringify(r.body).slice(0, 160)}` };
    });
    if (!up.ok) { setRunning(false); return; }

    // 3) download
    await runStep<null>("download", async () => {
      const dl = await fetch(`${apiBase}/v1/storage/object/public/avatars/${encodeURIComponent(testName)}`);
      const txt = await dl.text();
      return (dl.ok && txt === testBody)
        ? { ok: true, value: null, detail: `${txt.length} bytes match` }
        : { ok: false, value: null, detail: `HTTP ${dl.status} — ${txt.slice(0, 120)}` };
    });

    // 4) backups
    await runStep<null>("backups", async () => {
      const bk = await jsonFetch(`${apiBase}/v1/admin/backups`, { headers: authed(token) });
      if (bk.ok) {
        const n = Array.isArray(bk.body) ? bk.body.length : (bk.body as { items?: unknown[] })?.items?.length ?? 0;
        return { ok: true, value: null, detail: `${n} backup(s) visible` };
      }
      if (bk.status === 403) return { ok: true, value: null, skip: true, detail: "admin-only — sign in as admin to run" };
      return { ok: false, value: null, detail: `HTTP ${bk.status}` };
    });

    // 5+6) realtime subscribe + insert (single retryable block)
    const wsUrl = wsUrlFrom(apiBase) + `?apikey=${encodeURIComponent(anonKey)}&access_token=${encodeURIComponent(token)}`;
    let todoId: string | null = null;
    let wsRef: WebSocket | null = null;

    const rtSub = await runStep<{ ws: WebSocket | null; evPromise: Promise<boolean> }>("rt-sub", async () => {
      return await new Promise((resolve) => {
        let ws: WebSocket;
        try { ws = new WebSocket(wsUrl); }
        catch (e) { resolve({ ok: false, value: { ws: null, evPromise: Promise.resolve(false) }, detail: e instanceof Error ? e.message : String(e) }); return; }
        const t = setTimeout(() => resolve({ ok: false, value: { ws, evPromise: Promise.resolve(false) }, detail: "WS open timeout (6s)" }), 6000);
        ws.onopen = () => {
          clearTimeout(t);
          ws.send(JSON.stringify({ type: "subscribe", channel: "realtime:public:todos", ref: "1" }));
          const evPromise = new Promise<boolean>((r2) => {
            const t2 = setTimeout(() => r2(false), 8000);
            ws.onmessage = (ev) => {
              try {
                const msg = JSON.parse(String(ev.data));
                if (msg.type === "postgres_changes" || msg.event === "INSERT" || msg.record) { clearTimeout(t2); r2(true); }
              } catch { /* ignore */ }
            };
          });
          resolve({ ok: true, value: { ws, evPromise }, detail: "WS open + subscribed" });
        };
        ws.onerror = () => { clearTimeout(t); resolve({ ok: false, value: { ws, evPromise: Promise.resolve(false) }, detail: "WS error" }); };
      });
    });
    wsRef = rtSub.value.ws;

    await runStep<null>("rt-emit", async () => {
      await new Promise((r) => setTimeout(r, 500));
      const ins = await jsonFetch(`${apiBase}/v1/rest/todos`, {
        method: "POST",
        headers: { ...authed(token), Prefer: "return=representation" },
        body: JSON.stringify({ user_id: userId, title: `e2e ${Date.now()}` }),
      });
      if (ins.ok) {
        const rows = Array.isArray(ins.body) ? ins.body : [ins.body];
        todoId = (rows[0] as { id?: string })?.id ?? null;
      }
      const eventOk = await rtSub.value.evPromise;
      return eventOk
        ? { ok: true, value: null, detail: "INSERT event received" }
        : { ok: false, value: null, detail: ins.ok ? "insert ok but no event within 8s" : `insert failed HTTP ${ins.status}` };
    });

    // 7) cleanup — no retries, best-effort
    setStep("cleanup", { status: "running" });
    let cleanupDetail = "";
    const del = await jsonFetch(`${apiBase}/v1/storage/object/avatars/${encodeURIComponent(testName)}`, { method: "DELETE", headers: authed(token) });
    cleanupDetail += `file: ${del.ok ? "ok" : `HTTP ${del.status}`}`;
    if (todoId) {
      const dt = await jsonFetch(`${apiBase}/v1/rest/todos?id=eq.${todoId}`, { method: "DELETE", headers: authed(token) });
      cleanupDetail += ` · todo: ${dt.ok ? "ok" : `HTTP ${dt.status}`}`;
    }
    try { wsRef?.close(); } catch { /* ignore */ }
    setStep("cleanup", { status: "ok", detail: cleanupDetail });

    setRunning(false);
  }, [apiBase, anonKey, email, password, maxRetries]);

  const canRun = anonKey && email && password && !running;

  const doExport = (kind: "json" | "html") => {
    const reportSteps: ReportStep[] = steps.map((s) => ({
      key: s.key, label: s.label,
      status: s.status === "idle" ? "idle" : s.status,
      ms: s.ms, detail: s.detail, attempts: s.attempts,
      error: s.status === "fail" ? s.detail : undefined,
    }));
    const report = buildReport({ tool: "e2e-runner", apiBase, steps: reportSteps });
    (kind === "json" ? downloadReportJson : downloadReportHtml)(report);
  };
  const hasResults = steps.some((s) => s.status !== "idle");

  return (
    <div className="mt-3 rounded-md border border-border/60 bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <input type="password" placeholder="pk_anon_…" value={anonKey}
          onChange={(e) => setAnonKey(e.target.value)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono" />
        <input type="email" placeholder="test@example.com" value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono" />
        <input type="password" placeholder="password" value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-xs font-mono" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button onClick={run} disabled={!canRun}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run end-to-end flow
        </button>
        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Max retries per step
          <input type="number" min={0} max={8} value={maxRetries}
            onChange={(e) => setMaxRetries(Math.max(0, Math.min(8, Number(e.target.value) || 0)))}
            className="w-14 rounded-md border border-border/60 bg-background px-2 py-1 text-xs font-mono" />
        </label>
        <button onClick={() => doExport("json")} disabled={running || !hasResults}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <FileJson className="h-3.5 w-3.5" /> JSON
        </button>
        <button onClick={() => doExport("html")} disabled={running || !hasResults}
          className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-card/60 px-2 py-1.5 text-xs hover:bg-accent disabled:opacity-50">
          <FileCode className="h-3.5 w-3.5" /> HTML
        </button>
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <AlertCircle className="h-3 w-3" /> Uses a real test user + inserts a real todo (auto-cleaned up).
        </span>
      </div>

      <ol className="mt-3 space-y-1 text-xs">
        {steps.map((s) => (
          <li key={s.key} className="flex items-start gap-2 rounded border border-border/50 bg-background/60 p-2">
            <StatusDot s={s.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.label}</span>
                {typeof s.ms === "number" && <span className="ml-auto text-muted-foreground">{s.ms}ms</span>}
                {typeof s.attempts === "number" && s.attempts > 1 && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                    {s.attempts} attempts
                  </span>
                )}
              </div>
              {s.detail && <div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{s.detail}</div>}
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Save className="h-3 w-3" /> Credentials stay in browser memory only. Retries use exponential backoff (500ms base, cap 6s).
      </div>
    </div>
  );
}
