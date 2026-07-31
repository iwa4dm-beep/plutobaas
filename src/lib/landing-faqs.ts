// Extracted so route code-splitting keeps this data available to head().
export const faqs = [
  {
    q: "How does Pluto handle CORS?",
    a: "Every project has a strict allow-list managed in Dashboard → CORS. No wildcards in production. Preflight is served by the API, and disallowed origins are rejected before they hit any module. Add your published frontend origin (e.g. https://backend-joy.lovable.app) before going live.",
  },
  {
    q: "What is Row-Level Security (RLS) and how do I use it?",
    a: "Pluto uses native Postgres RLS. Every request sets a Postgres session with the JWT claims (sub, role, workspace_id), so policies like posts.owner = auth.uid() run server-side. The Dashboard ships a policy editor and end-to-end regression tests so bad policies are caught before deploy.",
  },
  {
    q: "How is realtime implemented?",
    a: "Realtime v5 is a WebSocket gateway with sharded rooms, presence, ordered broadcast and backpressure. It piggybacks on Postgres logical replication for row-change events (subscribeTable) and adds application-level channels for chat, cursors and presence.",
  },
  {
    q: "Is pricing per-project or per-workspace?",
    a: "Cloud plans are billed per project. A workspace can hold many projects, each on its own plan. Self-hosted is free forever regardless of workspace or project count.",
  },
  {
    q: "How do I deploy Pluto?",
    a: "Four common paths: (1) docker compose up -d locally; (2) flyctl deploy using the shipped deploy/fly.toml; (3) Railway 1-click via railway.json; (4) Render blueprint via render.yaml. All four boot the same image and pass /readyz before serving traffic.",
  },
  {
    q: "Can I migrate from Firebase or Supabase?",
    a: "Yes. The Data API mirrors PostgREST semantics, so Supabase-JS query patterns port directly. For Firebase, use the Pluto CLI import command to move Auth users and Firestore collections into Postgres tables.",
  },
];
