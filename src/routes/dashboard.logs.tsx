import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoLog } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/logs")({
  component: LogsPage,
});

const levelClass: Record<PlutoLog["level"], string> = {
  info: "bg-sky-500/15 text-sky-600",
  warn: "bg-amber-500/15 text-amber-600",
  error: "bg-destructive/15 text-destructive",
};

function LogsPage() {
  const [logs, setLogs] = useState<PlutoLog[]>([]);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => { pluto.logs.list().then(setLogs); }, []);
  const view = filter === "all" ? logs : logs.filter((l) => l.source === filter);

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Auth, REST, Storage, এবং Admin API request log।"
        actions={
          <select value={filter} onChange={(e) => setFilter(e.target.value)} className="rounded-md border border-input bg-background px-2 py-1 text-sm">
            <option value="all">All sources</option>
            <option value="auth">auth</option>
            <option value="rest">rest</option>
            <option value="storage">storage</option>
            <option value="admin">admin</option>
          </select>
        }
      />

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground w-44">Time</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground w-20">Level</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground w-24">Source</th>
              <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Message</th>
            </tr>
          </thead>
          <tbody>
            {view.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-4 py-2 text-xs font-mono text-muted-foreground">{new Date(l.ts).toLocaleTimeString()}</td>
                <td className="px-4 py-2"><span className={"inline-flex rounded px-1.5 py-0.5 text-[10px] uppercase " + levelClass[l.level]}>{l.level}</span></td>
                <td className="px-4 py-2 text-xs text-muted-foreground">{l.source}</td>
                <td className="px-4 py-2 text-sm">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
