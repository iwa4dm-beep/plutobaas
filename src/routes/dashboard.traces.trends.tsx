import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, ArrowLeft } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from "recharts";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { adminTraces, isLive, type AdminTraceStats } from "@/lib/pluto/live";
import { TraceAccessGate } from "@/components/pluto/TraceAccessGate";

export const Route = createFileRoute("/dashboard/traces/trends")({
  head: () => ({
    meta: [
      { title: "Error rate trends — Pluto" },
      { name: "description", content: "5xx, 4xx and validation failure rates over time with drill-down to the trace viewer." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: GatedTrendsPage,
});

function GatedTrendsPage() {
  return (
    <TraceAccessGate permission="view">
      <TrendsPage />
    </TraceAccessGate>
  );
}

const RANGES: Array<{ label: string; hours: number; bucket: "hour" | "day" }> = [
  { label: "Last 1h",   hours: 1,        bucket: "hour" },
  { label: "Last 6h",   hours: 6,        bucket: "hour" },
  { label: "Last 24h",  hours: 24,       bucket: "hour" },
  { label: "Last 7d",   hours: 24 * 7,   bucket: "day"  },
  { label: "Last 30d",  hours: 24 * 30,  bucket: "day"  },
];

function TrendsPage() {
  const navigate = useNavigate();
  const [rangeIdx, setRangeIdx] = useState(2);
  const [endpoint, setEndpoint] = useState("");
  const [data, setData] = useState<AdminTraceStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const window = useMemo(() => {
    const r = RANGES[rangeIdx];
    const to = new Date();
    const from = new Date(to.getTime() - r.hours * 3600_000);
    return { from: from.toISOString(), to: to.toISOString(), bucket: r.bucket };
  }, [rangeIdx]);

  const load = useCallback(async () => {
    if (!isLive()) { setErr("Live backend not configured."); return; }
    setLoading(true); setErr(null);
    try {
      const r = await adminTraces.stats({
        bucket: window.bucket,
        from: window.from,
        to: window.to,
        endpoint: endpoint || undefined,
      });
      setData(r);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [window, endpoint]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => {
    const pts = data?.points ?? [];
    return {
      s5xx: pts.reduce((s, p) => s + p.s5xx, 0),
      s4xx: pts.reduce((s, p) => s + p.s4xx, 0),
      validation: pts.reduce((s, p) => s + p.validation, 0),
      total: pts.reduce((s, p) => s + p.total, 0),
    };
  }, [data]);

  const drillTo = (kind: "5xx" | "4xx" | "validation") => {
    const search: Record<string, unknown> = { from: window.from, to: window.to };
    if (endpoint) search.endpoint = endpoint;
    if (kind === "5xx") { search.minStatus = 500; search.maxStatus = 599; }
    else if (kind === "4xx") { search.minStatus = 400; search.maxStatus = 499; }
    else search.errorCode = "validation_failed";
    void navigate({ to: "/dashboard/traces", search });
  };

  const chartData = (data?.points ?? []).map((p) => ({
    ...p,
    label: window.bucket === "hour"
      ? new Date(p.bucket).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : new Date(p.bucket).toLocaleDateString(),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Error rate trends"
        description="5xx, 4xx and validation failures over time. Click any total to drill into the trace viewer with the same filters."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard/traces"><ArrowLeft className="h-4 w-4 mr-1.5" /> Trace viewer</Link>
            </Button>
            <Button size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1.5" />}
              Refresh
            </Button>
          </div>
        }
      />

      <Card>
        <CardContent className="pt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((r, i) => (
              <Button key={r.label} size="sm" variant={i === rangeIdx ? "default" : "outline"} onClick={() => setRangeIdx(i)}>
                {r.label}
              </Button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Endpoint filter</span>
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)}
                placeholder="/admin/v1/tokens" className="font-mono text-sm w-64" />
            </div>
          </div>
          {data?.warning && (
            <div className="text-xs text-amber-700 bg-amber-500/10 border border-amber-500/30 rounded p-2">
              {data.warning}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <TotalCard label="5xx server errors"   value={totals.s5xx}       tone="rose"    onClick={() => drillTo("5xx")} />
        <TotalCard label="4xx client errors"   value={totals.s4xx}       tone="amber"   onClick={() => drillTo("4xx")} />
        <TotalCard label="Validation failures" value={totals.validation} tone="amber"   onClick={() => drillTo("validation")} />
        <TotalCard label="Total captured"      value={totals.total}      tone="neutral" />
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Errors per {window.bucket}</CardTitle></CardHeader>
        <CardContent>
          {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
          {chartData.length === 0 && !loading && (
            <div className="text-sm text-muted-foreground py-8 text-center">
              No error events in this window.
            </div>
          )}
          {chartData.length > 0 && (
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="s5xx"       name="5xx"        stroke="#e11d48" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="s4xx"       name="4xx"        stroke="#d97706" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="validation" name="validation" stroke="#7c3aed" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TotalCard({ label, value, tone, onClick }: {
  label: string; value: number; tone: "rose" | "amber" | "neutral"; onClick?: () => void;
}) {
  const cls = tone === "rose"  ? "text-rose-600"
           : tone === "amber" ? "text-amber-700"
           : "text-foreground";
  return (
    <Card className={onClick ? "cursor-pointer hover:border-primary/50 transition-colors" : ""} onClick={onClick}>
      <CardContent className="pt-4">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold ${cls} mt-1`}>{value}</div>
        {onClick && <Badge variant="outline" className="mt-2 text-[10px]">Click to drill down</Badge>}
      </CardContent>
    </Card>
  );
}
