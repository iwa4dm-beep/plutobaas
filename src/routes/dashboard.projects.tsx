import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";

export const Route = createFileRoute("/dashboard/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [copied, setCopied] = useState<string | null>(null);
  const keys = [
    { name: "anon (public)", value: "pk_anon_3f9k2lq8d7s2nv0w" },
    { name: "service_role (server only)", value: "sk_service_8xv2j7l4m1q5pdz0", danger: true },
  ];

  function copy(v: string) {
    navigator.clipboard.writeText(v);
    setCopied(v);
    setTimeout(() => setCopied(null), 1200);
  }

  return (
    <div>
      <PageHeader title="Projects & API Keys" description="এই Pluto instance-এর project URL ও keys।" />

      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="font-medium">Default project</h2>
        </div>

        <div className="mt-5 space-y-4">
          <Field label="Project URL" value="http://localhost:8000" onCopy={copy} copied={copied} />
          {keys.map((k) => (
            <Field key={k.name} label={k.name} value={k.value} onCopy={copy} copied={copied} danger={k.danger} />
          ))}
        </div>

        <p className="mt-6 text-xs text-muted-foreground">
          ⚠️ <span className="font-medium">service_role</span> key কখনো frontend-এ ব্যবহার করবেন না — এটি RLS bypass করে।
        </p>
      </div>
    </div>
  );
}

function Field({ label, value, onCopy, copied, danger }: { label: string; value: string; onCopy: (v: string) => void; copied: string | null; danger?: boolean }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5">{label}</div>
      <div className="flex items-center gap-2">
        <code className={"flex-1 rounded-md border border-input bg-muted/40 px-3 py-2 text-xs font-mono " + (danger ? "text-destructive" : "")}>{value}</code>
        <button
          onClick={() => onCopy(value)}
          className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-2 text-xs hover:bg-accent"
        >
          <Copy className="h-3.5 w-3.5" />
          {copied === value ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}
