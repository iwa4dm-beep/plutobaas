import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { FolderPlus, Trash2, Upload } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { pluto, type PlutoBucket, type PlutoFile } from "@/lib/pluto/client";

export const Route = createFileRoute("/dashboard/storage")({
  component: StoragePage,
});

function fmtSize(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function StoragePage() {
  const [buckets, setBuckets] = useState<PlutoBucket[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [files, setFiles] = useState<PlutoFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    const bs = await pluto.storage.listBuckets();
    setBuckets(bs);
    if (!active && bs[0]) setActive(bs[0].name);
  }
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (active) pluto.storage.listFiles(active).then(setFiles); }, [active]);

  async function newBucket() {
    const name = prompt("Bucket name?");
    if (!name) return;
    const isPublic = confirm("Public bucket? (Cancel = private)");
    try { await pluto.storage.createBucket(name, isPublic); refresh(); }
    catch (e) { alert(e instanceof Error ? e.message : "error"); }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    if (!active) return;
    const f = e.target.files?.[0];
    if (!f) return;
    await pluto.storage.upload(active, { name: f.name, size: f.size, type: f.type });
    pluto.storage.listFiles(active).then(setFiles);
    refresh();
    if (fileInput.current) fileInput.current.value = "";
  }

  async function removeFile(key: string) {
    if (!active) return;
    await pluto.storage.remove(active, key);
    pluto.storage.listFiles(active).then(setFiles);
    refresh();
  }

  return (
    <div>
      <PageHeader
        title="Storage"
        description="Public/private buckets ও file management।"
        actions={
          <button onClick={newBucket} className="inline-flex items-center gap-1.5 rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
            <FolderPlus className="h-4 w-4" /> New bucket
          </button>
        }
      />

      <div className="grid lg:grid-cols-[240px_1fr] gap-6">
        <aside className="rounded-lg border border-border bg-card p-3 h-fit">
          <ul className="space-y-0.5">
            {buckets.map((b) => (
              <li key={b.name}>
                <button
                  onClick={() => setActive(b.name)}
                  className={"w-full text-left px-2 py-2 rounded text-sm " + (active === b.name ? "bg-accent" : "hover:bg-accent/60")}
                >
                  <div className="flex items-center justify-between">
                    <span>{b.name}</span>
                    <span className={"text-[10px] rounded-full px-1.5 py-0.5 " + (b.public ? "bg-emerald-500/15 text-emerald-600" : "bg-muted text-muted-foreground")}>
                      {b.public ? "public" : "private"}
                    </span>
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{b.file_count} files · {fmtSize(b.size_bytes)}</div>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="text-sm font-medium">{active ?? "—"}</div>
            <label className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer">
              <Upload className="h-3.5 w-3.5" /> Upload
              <input ref={fileInput} type="file" className="hidden" onChange={onUpload} />
            </label>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Key</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Type</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Size</th>
                <th className="text-left px-4 py-2 text-xs font-medium text-muted-foreground">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.key} className="border-t border-border">
                  <td className="px-4 py-2 font-mono text-xs">{f.key}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{f.content_type}</td>
                  <td className="px-4 py-2 text-xs">{fmtSize(f.size)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">{new Date(f.updated_at).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={() => removeFile(f.key)} className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
              {files.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">No files yet.</td></tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
