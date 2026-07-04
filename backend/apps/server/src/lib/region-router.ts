// Phase 53 — Per-region deployment router.
// Picks the closest active deployment given a client region hint. Falls back
// to the deployment with the smallest lexicographic region id when no match.
export type Deployment = { region: string; module: string; version: number; status: "active" | "draining" | "retired" };

// Simple region adjacency map — production would use a geo DB.
const NEIGHBORS: Record<string, string[]> = {
  "us-east": ["us-east", "us-west", "eu-west"],
  "us-west": ["us-west", "us-east", "ap-northeast"],
  "eu-west": ["eu-west", "eu-central", "us-east"],
  "eu-central": ["eu-central", "eu-west"],
  "ap-northeast": ["ap-northeast", "ap-southeast", "us-west"],
  "ap-southeast": ["ap-southeast", "ap-northeast"],
};

export function pickDeployment(deps: Deployment[], clientRegion: string): Deployment | null {
  const active = deps.filter((d) => d.status === "active");
  if (active.length === 0) return null;
  const order = NEIGHBORS[clientRegion] ?? [clientRegion];
  for (const r of order) {
    const hit = active.find((d) => d.region === r);
    if (hit) return hit;
  }
  return [...active].sort((a, b) => a.region.localeCompare(b.region))[0]!;
}
