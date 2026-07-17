import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, KeyRound, RefreshCw, ShieldOff, XCircle } from "lucide-react";
import { toast } from "sonner";
import { PageHeader } from "@/components/pluto/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getActiveSubdomains, type ActiveSubdomain } from "@/lib/pluto/vps-health.functions";
import { rotateSlugSecret, revokeSlugSecret, type WorkerJson } from "@/lib/pluto/slug-secrets.functions";

export const Route = createFileRoute("/dashboard/slug-secrets")({
  component: SlugSecretsPage,
  head: () => ({
    meta: [
      { title: "Slug Secrets — Pluto Admin" },
      { name: "description", content: "List all known slugs and rotate or revoke per-subdomain secrets." },
    ],
  }),
});

type ActionResult = { at: string; slug: string; action: "rotate" | "revoke"; ok: boolean; message: string };

function SlugSecretsPage() {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<Record<string, "rotate" | "revoke" | undefined>>({});
  const [results, setResults] = useState<ActionResult[]>([]);
  const rotate = useServerFn(rotateSlugSecret);
  const revoke = useServerFn(revokeSlugSecret);
  const list = useServerFn(getActiveSubdomains);

  const q = useQuery({
    queryKey: ["active-subdomains"],
    queryFn: () => list({ data: { baseDomain: "" } }),
    refetchInterval: 30_000,
  });

  const rows = useMemo<ActiveSubdomain[]>(() => {
    const all = q.data?.subdomains ?? [];
    const f = filter.trim().toLowerCase();
    return f ? all.filter((r) => r.slug.toLowerCase().includes(f) || r.host.toLowerCase().includes(f)) : all;
  }, [q.data, filter]);

  const record = (r: ActionResult) => setResults((p) => [r, ...p].slice(0, 25));

  async function onRotate(slug: string) {
    setBusy((b) => ({ ...b, [slug]: "rotate" }));
    try {
      const res = (await rotate({ data: { slug } })) as WorkerJson;
      const ok = Boolean(res?.ok);
      const msg = ok
        ? `Rotated. New secret ${(res?.preview as string) ?? "•••"} (version ${(res?.version as number | string) ?? "?"})`
        : `Failed: ${(res?.error as string) ?? `HTTP ${res?.status ?? "?"}`}`;
      record({ at: new Date().toISOString(), slug, action: "rotate", ok, message: msg });
      (ok ? toast.success : toast.error)(`${slug}: ${msg}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record({ at: new Date().toISOString(), slug, action: "rotate", ok: false, message: msg });
      toast.error(`${slug}: ${msg}`);
    } finally {
      setBusy((b) => ({ ...b, [slug]: undefined }));
    }
  }

  async function onRevoke(slug: string) {
    if (!confirm(`Revoke the current secret for ${slug}?`)) return;
    setBusy((b) => ({ ...b, [slug]: "revoke" }));
    try {
      const res = (await revoke({ data: { slug } })) as WorkerJson;
      const ok = Boolean(res?.ok);
      const msg = ok ? "Secret revoked." : `Failed: ${(res?.error as string) ?? `HTTP ${res?.status ?? "?"}`}`;
      record({ at: new Date().toISOString(), slug, action: "revoke", ok, message: msg });
      (ok ? toast.success : toast.error)(`${slug}: ${msg}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      record({ at: new Date().toISOString(), slug, action: "revoke", ok: false, message: msg });
      toast.error(`${slug}: ${msg}`);
    } finally {
      setBusy((b) => ({ ...b, [slug]: undefined }));
    }
  }

  return (
    <div className="container mx-auto max-w-6xl space-y-6 p-6">
      <PageHeader
        title="Slug Secrets"
        description="Rotate or revoke the per-subdomain shared secret. New secrets are picked up by the worker immediately."
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3">
          <CardTitle>Known slugs</CardTitle>
          <div className="flex items-center gap-2">
            <Input
              placeholder="Filter by slug or host"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="w-64"
            />
            <Button variant="outline" size="sm" onClick={() => q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={`h-4 w-4 ${q.isFetching ? "animate-spin" : ""}`} />
              <span className="ml-2">Refresh</span>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {q.data?.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              {q.data.error}
              {q.data.hint ? <div className="mt-1 text-xs opacity-80">{q.data.hint}</div> : null}
            </div>
          ) : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Slug</TableHead>
                <TableHead>Host</TableHead>
                <TableHead>Serving</TableHead>
                <TableHead>SSL</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-sm text-muted-foreground">
                    {q.isLoading ? "Loading…" : "No slugs found."}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r) => {
                  const b = busy[r.slug];
                  const serveOk = r.ok || r.https?.status === 200 || r.http?.status === 200;
                  return (
                    <TableRow key={r.slug}>
                      <TableCell className="font-mono text-xs">{r.slug}</TableCell>
                      <TableCell className="font-mono text-xs">
                        <a href={r.url} target="_blank" rel="noreferrer" className="underline">
                          {r.host}
                        </a>
                      </TableCell>
                      <TableCell>
                        {serveOk ? (
                          <Badge variant="default" className="gap-1"><CheckCircle2 className="h-3 w-3" />OK</Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1"><XCircle className="h-3 w-3" />{r.https?.status || r.http?.status || "—"}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {r.ssl?.valid ? (
                          <Badge variant="secondary">
                            {r.ssl.daysLeft != null ? `${r.ssl.daysLeft}d` : "valid"}
                          </Badge>
                        ) : (
                          <Badge variant="outline">—</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => onRotate(r.slug)} disabled={!!b}>
                            <KeyRound className={`h-3.5 w-3.5 ${b === "rotate" ? "animate-pulse" : ""}`} />
                            <span className="ml-1">Rotate</span>
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => onRevoke(r.slug)} disabled={!!b}>
                            <ShieldOff className={`h-3.5 w-3.5 ${b === "revoke" ? "animate-pulse" : ""}`} />
                            <span className="ml-1">Revoke</span>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent actions</CardTitle></CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <div className="text-sm text-muted-foreground">No actions yet.</div>
          ) : (
            <ul className="space-y-1 text-sm">
              {results.map((r, i) => (
                <li key={i} className="flex items-center gap-2">
                  {r.ok ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> : <XCircle className="h-3.5 w-3.5 text-destructive" />}
                  <span className="font-mono text-xs text-muted-foreground">{new Date(r.at).toLocaleTimeString()}</span>
                  <span className="font-mono text-xs">{r.slug}</span>
                  <Badge variant="outline">{r.action}</Badge>
                  <span className="truncate">{r.message}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
