import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Database, Files, ScrollText, Users } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/")({
  component: Overview,
});

function Overview() {
  const [stats, setStats] = useState({ users: 0, tables: 0, buckets: 0, logs: 0 });

  useEffect(() => {
    (async () => {
      const [u, t, b, l] = await Promise.all([
        pluto.users.list(),
        pluto.db.listTables(),
        pluto.storage.listBuckets(),
        pluto.logs.list(),
      ]);
      setStats({ users: u.length, tables: t.length, buckets: b.length, logs: l.length });
    })();
  }, []);

  const cards = [
    { label: "Users", value: stats.users, icon: Users },
    { label: "Tables", value: stats.tables, icon: Database },
    { label: "Buckets", value: stats.buckets, icon: Files },
    { label: "Recent logs", value: stats.logs, icon: ScrollText },
  ];

  return (
    <div>
      <PageHeader title="Overview" description="আপনার Pluto instance-এর সংক্ষিপ্ত অবস্থা।" />
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, value, icon: Icon }) => (
          <div key={label} className="rounded-lg border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{label}</span>
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="mt-3 text-3xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <div className="mt-8 rounded-lg border border-border bg-card p-6">
        <h2 className="font-medium">Connect your frontend</h2>
        <p className="text-sm text-muted-foreground mt-1">নিচের snippet দিয়ে যেকোনো app থেকে এই backend-এ connect করুন।</p>
        <pre className="mt-4 rounded-md bg-muted/40 p-4 text-xs overflow-x-auto"><code>{`import { createPlutoClient } from "@pluto/client";

const pluto = createPlutoClient({
  url: "http://localhost:8000",
  anonKey: "YOUR_PROJECT_ANON_KEY",
});

// Auth
await pluto.auth.signIn({ email, password });

// Auto REST
const { data } = await pluto
  .from("posts")
  .select("id, title")
  .order("created_at", { ascending: false });

// Storage
await pluto.storage.from("avatars").upload("me.png", file);`}</code></pre>
      </div>
    </div>
  );
}
