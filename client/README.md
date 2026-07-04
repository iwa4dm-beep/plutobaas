# @pluto/client

Minimal typed TypeScript SDK for the Pluto backend. Targets the canonical
Wave 3 endpoints only (auth, `/rest/v4`, `/storage/v4`, `/rt/v5`, `/vec/v3`,
`/jobs/v2`, `/ai/v1`). No dependencies — works in browsers, Bun, Node ≥ 20.

## Install

```bash
# from a monorepo peer (recommended during Wave 3)
bun add @pluto/client@workspace:*

# or a published tarball
bun add @pluto/client
```

## Quick start

```ts
import { createClient } from "@pluto/client";

const pluto = createClient({
  baseUrl: import.meta.env.VITE_PLUTO_URL,   // e.g. "http://localhost:3000"
  apikey: import.meta.env.VITE_PLUTO_ANON_KEY, // publishable, safe in the browser
});

// Auth
const session = await pluto.auth.signIn("me@example.com", "hunter2");

// Data API v4
const { rows, next_cursor } = await pluto.data.query<{ id: string; title: string }>({
  table: "posts",
  select: ["id", "title"],
  filter: { published: true },
  order: [{ column: "created_at", ascending: false }],
  limit: 20,
});

// Streaming JSON (NDJSON) — cursor pagination handled server-side
for await (const row of pluto.data.stream<{ id: string }>({ table: "events", limit: 10_000 })) {
  console.log(row.id);
}

// Storage v4
const put = await pluto.storage.upload("avatars", `${session.user.id}.png`, file);

// Realtime v5 — ordered delivery + WS
const sub = pluto.realtime.subscribe("room:general", {
  onMessage: ({ seq, payload }) => console.log(seq, payload),
});
await pluto.realtime.publish({ room: "room:general", payload: { text: "hi" } });

// Vector v3 hybrid search
const { hits } = await pluto.vector.hybridSearch({
  index: "docs",
  query: "how to deploy",
  k: 8,
  alpha: 0.7,
});

// Jobs v2 workflow
const run = await pluto.jobs.run({ workflow: "index_all_docs", input: { tenant: "acme" } });
```

## Design notes

- **No hidden state.** `PlutoClient` holds an optional in-memory session; persist
  it yourself (localStorage, cookies) via `getSession()` / `setSession()`.
- **Never ship the service-role key.** This SDK only accepts publishable
  (`apikey`) + bearer tokens. Service-role code belongs on the server.
- **Streaming reads use NDJSON**, not SSE, so they work with `fetch` in every
  runtime and don't need a special client. The generator patterns (`data.stream`,
  `vector.embeddingsStream`) apply natural backpressure — the server writes only
  when the client reads.
- **Legacy modules are archived.** If you're still on `/rest/v1`, `/storage/v1`
  writes, `/realtime/v1`, `/functions/v1`, or `/jobs/v1`, run the server with
  `PLUTO_ENABLE_LEGACY=1` during migration and swap to canonical calls.

See `docs/api/README.md` for the full endpoint catalog and feature-flag matrix.
