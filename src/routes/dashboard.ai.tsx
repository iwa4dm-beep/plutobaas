import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Sparkles, Send, Database, Activity } from "lucide-react";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardAiHelp } from "@/content/help/dashboard.ai";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { isLive, ai, type AiStatus, type ChatMessage } from "@/lib/pluto/live";

export const Route = createFileRoute("/dashboard/ai")({
  component: AiPage,
});

// ============================================================
// AI & Vector — Phase 16
// ------------------------------------------------------------
// Playground for embeddings + chat + vector search. Reads the
// /ai/v1/status endpoint so users can see whether the backend
// gateway is ready before hitting inference endpoints (which
// 501 until 16.1+).
// ============================================================

function AiPage() {
  const live = isLive();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const [embedInput, setEmbedInput] = useState("Pluto is a self-hostable BaaS.");
  const [embedResult, setEmbedResult] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("Explain vector search in one paragraph.");
  const [chatResult, setChatResult] = useState<string | null>(null);

  const [collection, setCollection] = useState("ai_embeddings_demo");
  const [vectorQuery, setVectorQuery] = useState("self-hosted database");
  const [vectorResult, setVectorResult] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    ai.status().then(setStatus).catch((e) => setStatusErr((e as Error).message));
  }, [live]);

  async function run(id: string, fn: () => Promise<unknown>, set: (s: string) => void) {
    setBusy(id);
    try { set(JSON.stringify(await fn(), null, 2)); }
    catch (e) { set(`ERROR: ${(e as Error).message}`); }
    finally { setBusy(null); }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI & Vector"
        description="Embeddings, streaming chat, and vector search — proxied through Pluto so your frontend never sees a provider key."

      />
      <HelpPanel help={dashboardAiHelp} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4" />
            Module status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {!live && (
            <div className="text-sm text-muted-foreground">
              Configure <code>VITE_PLUTO_URL</code> to check status.
            </div>
          )}
          {statusErr && <div className="text-sm text-destructive">{statusErr}</div>}
          {status && (
            <div className="flex flex-wrap gap-2 text-xs">
              <Badge variant="secondary">phase {status.phase}</Badge>
              <Badge variant={status.gateway_ready ? "default" : "destructive"}>
                gateway {status.gateway_ready ? "ready" : "missing key"}
              </Badge>
              {status.drivers.map((d) => <Badge key={d} variant="outline">{d}</Badge>)}
              <Badge variant="outline">
                vector allow: {status.vector_allow.join(", ") || "—"}
              </Badge>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4" />
              Embeddings playground
            </CardTitle>
            <CardDescription>
              POST /ai/v1/embeddings — default provider, default model.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={3} value={embedInput} onChange={(e) => setEmbedInput(e.target.value)} />
            <Button
              onClick={() => run("embed", () => ai.embed(embedInput), setEmbedResult)}
              disabled={!live || !!busy}
            >
              Embed
            </Button>
            {embedResult && (
              <pre className="text-xs bg-muted/40 border rounded-md p-3 max-h-64 overflow-auto">
                {embedResult}
              </pre>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Send className="h-4 w-4" />
              Chat playground
            </CardTitle>
            <CardDescription>
              POST /ai/v1/chat/completions — streaming lands in 16.3.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea rows={3} value={chatInput} onChange={(e) => setChatInput(e.target.value)} />
            <Button
              onClick={() => run("chat", () => ai.chat([{ role: "user", content: chatInput }] satisfies ChatMessage[]), setChatResult)}
              disabled={!live || !!busy}
            >
              Send
            </Button>
            {chatResult && (
              <pre className="text-xs bg-muted/40 border rounded-md p-3 max-h-64 overflow-auto">
                {chatResult}
              </pre>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Database className="h-4 w-4" />
            Vector search
          </CardTitle>
          <CardDescription>
            POST /ai/v1/vector/:collection/search — allow-listed tables only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="collection" className="max-w-xs" />
            <Input value={vectorQuery} onChange={(e) => setVectorQuery(e.target.value)} placeholder="query text" />
            <Button
              onClick={() => run("vec", () => ai.vectorSearch(collection, { query: vectorQuery, k: 10 }), setVectorResult)}
              disabled={!live || !!busy}
            >
              Search
            </Button>
          </div>
          {vectorResult && (
            <pre className="text-xs bg-muted/40 border rounded-md p-3 max-h-64 overflow-auto">
              {vectorResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
