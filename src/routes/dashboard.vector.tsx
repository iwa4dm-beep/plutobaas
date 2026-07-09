import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { vector, isLive, type VecCollection, type VecMatch } from "@/lib/pluto/live";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Search, Sparkles, Plus, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PaginatedTable } from "@/components/pluto/PaginatedTable";
import { usePaginatedTable } from "@/lib/pluto/usePaginatedTable";
import { AutoHelpPanel } from "@/components/help/AutoHelpPanel";

export const Route = createFileRoute("/dashboard/vector")({ component: VectorPage });

// Deterministic pseudo-embedding for demo/testing without an API key.
function fakeEmbed(text: string, dims = 64): number[] {
  const v = new Array(dims).fill(0);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    v[i % dims] += Math.sin(c * (i + 1)) * 0.5;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

function VectorPage() {
  const [colls, setColls] = useState<VecCollection[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [dims, setDims] = useState(64);
  const [docText, setDocText] = useState("");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<VecMatch[]>([]);
  const [topK, setTopK] = useState(5);
  const [embField, setEmbField] = useState<string>(""); // "" = use column
  const [fieldOptions, setFieldOptions] = useState<string[]>([]);

  async function refresh() {
    if (!isLive()) return;
    try { const r = await vector.collections(); setColls(r.collections); if (!active && r.collections[0]) setActive(r.collections[0].name); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function refreshFields(name: string) {
    try {
      const r = await vector.docs(name);
      const keys = new Set<string>();
      for (const d of r.docs.slice(0, 20)) {
        for (const [k, v] of Object.entries(d.metadata ?? {})) {
          if (Array.isArray(v) && v.every(x => typeof x === "number")) keys.add(k);
        }
      }
      setFieldOptions(Array.from(keys));
    } catch { /* ignore */ }
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (active) refreshFields(active); }, [active]);

  async function createColl() {
    if (!newName.trim()) return;
    try { await vector.createCollection(newName.trim(), dims); setNewName(""); toast.success("Collection created"); await refresh(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function ingest() {
    if (!active || !docText.trim()) return;
    const c = colls.find(c => c.name === active); const d = c?.dims ?? dims;
    try { await vector.upsert(active, [{ content: docText, embedding: fakeEmbed(docText, d) }]); setDocText(""); toast.success("Doc upserted"); await refresh(); await refreshFields(active); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function search() {
    if (!active || !query.trim()) return;
    const c = colls.find(c => c.name === active); const d = c?.dims ?? dims;
    try { const r = await vector.query(active, fakeEmbed(query, d), topK, embField || undefined); setMatches(r.matches); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><Sparkles className="h-5 w-5" /> Vector search</h1>
      <AutoHelpPanel slug={'dashboard.vector'} title={'Vector search'} description={''} />
          <p className="text-sm text-muted-foreground">Create embedding collections, ingest documents, and run similarity queries.</p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh}><RefreshCw className="h-4 w-4 mr-1" /> Refresh</Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px,1fr]">
        <Card>
          <CardHeader><CardTitle className="text-sm">Collections</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            <div className="flex gap-2">
              <Input placeholder="name" value={newName} onChange={e => setNewName(e.target.value)} />
              <Input className="w-20" type="number" value={dims} onChange={e => setDims(Number(e.target.value)||64)} />
              <Button size="sm" onClick={createColl}><Plus className="h-4 w-4" /></Button>
            </div>
            <div className="space-y-1">
              {colls.map(c => (
                <button key={c.id} onClick={() => setActive(c.name)}
                  className={"w-full text-left px-3 py-2 rounded-md text-sm flex items-center justify-between " +
                    (active === c.name ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}>
                  <span>{c.name}</span>
                  <Badge variant="secondary">{c.docs} · {c.dims}d</Badge>
                </button>
              ))}
              {colls.length === 0 && <div className="text-xs text-muted-foreground p-2">No collections.</div>}
            </div>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle className="text-sm">Ingest document</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <textarea className="w-full min-h-[80px] p-2 rounded-md border border-border bg-background text-sm"
                        placeholder="Paste content to embed & store…"
                        value={docText} onChange={e => setDocText(e.target.value)} />
              <div className="flex justify-end"><Button size="sm" onClick={ingest} disabled={!active}>Upsert</Button></div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-sm flex items-center gap-2"><Search className="h-4 w-4" /> Similarity query</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex gap-2 flex-wrap items-center">
                <Input placeholder="query text" className="flex-1 min-w-[200px]" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === "Enter" && search()} />
                <label className="text-xs text-muted-foreground">top-k</label>
                <Input type="number" className="w-20" min={1} max={50} value={topK} onChange={e => setTopK(Math.max(1, Math.min(50, Number(e.target.value) || 5)))} />
                <label className="text-xs text-muted-foreground">field</label>
                <select className="h-9 px-2 rounded-md border border-border bg-background text-xs" value={embField} onChange={e => setEmbField(e.target.value)}>
                  <option value="">embedding (default)</option>
                  {fieldOptions.map(f => <option key={f} value={f}>metadata.{f}</option>)}
                </select>
                <Button onClick={search} disabled={!active}>Search</Button>
              </div>
              <MatchesTable matches={matches} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MatchesTable({ matches }: { matches: VecMatch[] }) {
  const t = usePaginatedTable(matches, { pageSize: 20, defaultSort: { key: "score", dir: "desc" } });
  return (
    <PaginatedTable
      rows={t.rows} sorted={t.sorted}
      page={t.page} pageSize={t.pageSize} totalPages={t.totalPages}
      sortKey={t.sortKey} sortDir={t.sortDir}
      onPage={t.setPage} onSort={t.toggleSort}
      csvFilename="vector-matches.csv"
      csvColumns={["id","external_id","score","content"]}
      columns={[
        { key: "score", label: "score", className: "w-20",
          render: (r) => <span className="font-medium">{r.score.toFixed(4)}</span> },
        { key: "external_id", label: "id", className: "w-40",
          render: (r) => <span className="text-muted-foreground">{r.external_id ?? r.id.slice(0,8)}</span> },
        { key: "content", label: "content",
          render: (r) => <span className="line-clamp-2 text-muted-foreground">{r.content}</span> },
      ]}
      empty="No matches yet."
    />
  );
}
