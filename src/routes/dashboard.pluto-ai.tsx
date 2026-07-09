import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/pluto/PageHeader";
import { HelpPanel } from "@/components/help/HelpPanel";
import { dashboardPlutoAiHelp } from "@/content/help/dashboard.pluto-ai";
import { Link } from "@tanstack/react-router";
import { Sparkles, Search } from "lucide-react";

export const Route = createFileRoute("/dashboard/pluto-ai")({
  component: PlutoAiPage,
  head: () => ({ meta: [{ title: "AI Gateway" }] }),
});

function PlutoAiPage() {
  return (
    <div>
      <PageHeader
        title="AI Gateway"
        description="Unified gateway for LLM providers — manage keys, model routing, and usage. (Distinct from AI & Vector.)"
      />
      <HelpPanel help={dashboardPlutoAiHelp} />

      <div className="grid gap-4 md:grid-cols-2 mt-4">
        <div className="rounded-lg border border-border bg-card p-5">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-muted-foreground" />
            <h2 className="font-medium">Related surfaces</h2>
          </div>
          <ul className="space-y-2 text-sm">
            <li>
              <Link to="/dashboard/ai" className="text-primary hover:underline">
                AI & Vector →
              </Link>
              <span className="text-muted-foreground"> — embeddings & vector index</span>
            </li>
            <li>
              <Link to="/dashboard/vector" className="text-primary hover:underline">
                <Search className="inline h-3.5 w-3.5" /> Vector search →
              </Link>
              <span className="text-muted-foreground"> — HNSW query playground</span>
            </li>
          </ul>
        </div>

        <div className="rounded-lg border border-border bg-card p-5">
          <h2 className="font-medium mb-2">Coming soon</h2>
          <p className="text-sm text-muted-foreground">
            Provider key management, routing rules ও per-model usage dashboard এখানে যোগ হবে।
            আপাতত provider keys workspace settings/secrets থেকে configure করুন।
          </p>
        </div>
      </div>
    </div>
  );
}
