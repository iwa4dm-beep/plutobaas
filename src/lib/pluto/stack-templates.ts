/**
 * Stack-specific copy-paste templates rendered by the Connect wizard.
 * Placeholders __API__, __ANON__, __SERVICE__, __TABLE__ are substituted
 * at render time from the wizard config.
 */
export type Snippet = { file: string; lang: string; content: string };
export type StackTemplate = {
  id: string;
  name: string;
  blurb_en: string;
  blurb_bn: string;
  install: string;
  snippets: Snippet[];
};

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    id: "react-vite",
    name: "React + Vite",
    blurb_en: "Browser-only SPA. Anon key in the bundle, RLS does the guarding.",
    blurb_bn: "শুধু ব্রাউজার SPA। anon key bundle-এ থাকে, RLS-ই সুরক্ষা দেয়।",
    install: "bun add @pluto/js",
    snippets: [
      {
        file: ".env",
        lang: "env",
        content: `VITE_PLUTO_URL=__API__
VITE_PLUTO_ANON_KEY=__ANON__`,
      },
      {
        file: "src/lib/pluto.ts",
        lang: "ts",
        content: `import { createClient } from "@pluto/js";

export const pluto = createClient(
  import.meta.env.VITE_PLUTO_URL as string,
  import.meta.env.VITE_PLUTO_ANON_KEY as string,
  { auth: { persistSession: true, autoRefreshToken: true, storageKey: "pluto.auth.token" } },
);`,
      },
      {
        file: "src/hooks/useRows.ts",
        lang: "ts",
        content: `import { useEffect, useState } from "react";
import { pluto } from "@/lib/pluto";

export function useRows() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    pluto.from("__TABLE__").select("*").then(({ data }) => setRows(data ?? []));
    const ch = pluto
      .channel("__TABLE__-changes")
      .on("postgres_changes", { event: "*", schema: "public", table: "__TABLE__" },
        () => pluto.from("__TABLE__").select("*").then(({ data }) => setRows(data ?? [])))
      .subscribe();
    return () => { pluto.removeChannel(ch); };
  }, []);
  return rows;
}`,
      },
    ],
  },
  {
    id: "nextjs",
    name: "Next.js (App Router)",
    blurb_en: "Split browser + server clients. Service key never crosses to the client.",
    blurb_bn: "ব্রাউজার ও সার্ভার আলাদা client। service key কখনো client-এ যায় না।",
    install: "npm install @pluto/js",
    snippets: [
      {
        file: ".env.local",
        lang: "env",
        content: `NEXT_PUBLIC_PLUTO_URL=__API__
NEXT_PUBLIC_PLUTO_ANON_KEY=__ANON__
PLUTO_SERVICE_ROLE_KEY=__SERVICE__`,
      },
      {
        file: "lib/pluto.ts",
        lang: "ts",
        content: `import { createClient } from "@pluto/js";

export const pluto = createClient(
  process.env.NEXT_PUBLIC_PLUTO_URL!,
  process.env.NEXT_PUBLIC_PLUTO_ANON_KEY!,
);`,
      },
      {
        file: "lib/pluto.server.ts",
        lang: "ts",
        content: `import "server-only";
import { createClient } from "@pluto/js";

// Bypasses RLS — server routes / actions only.
export const plutoAdmin = createClient(
  process.env.NEXT_PUBLIC_PLUTO_URL!,
  process.env.PLUTO_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);`,
      },
      {
        file: "app/api/rows/route.ts",
        lang: "ts",
        content: `import { plutoAdmin } from "@/lib/pluto.server";

export async function GET() {
  const { data, error } = await plutoAdmin.from("__TABLE__").select("*").limit(50);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ data });
}`,
      },
    ],
  },
  {
    id: "tanstack",
    name: "TanStack Start",
    blurb_en: "Server functions read secrets inside the handler; loaders hydrate the client.",
    blurb_bn: "Server function handler-এর ভেতরে secret পড়ে; loader client hydrate করে।",
    install: "bun add @pluto/js",
    snippets: [
      {
        file: "src/lib/pluto.functions.ts",
        lang: "ts",
        content: `import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@pluto/js";

export const listRows = createServerFn({ method: "GET" }).handler(async () => {
  const pluto = createClient(process.env.PLUTO_URL!, process.env.PLUTO_SERVICE_ROLE_KEY!);
  const { data, error } = await pluto.from("__TABLE__").select("*").limit(50);
  if (error) throw new Error(error.message);
  return data;
});`,
      },
    ],
  },
  {
    id: "prisma",
    name: "Prisma",
    blurb_en: "Direct Postgres access for typed queries and migrations alongside Pluto.",
    blurb_bn: "Pluto-র পাশাপাশি সরাসরি Postgres — typed query ও migration-এর জন্য।",
    install: "npm install prisma @prisma/client && npx prisma init",
    snippets: [
      {
        file: ".env",
        lang: "env",
        content: `DATABASE_URL="postgresql://postgres:PASSWORD@db.host:5432/postgres?sslmode=require&schema=public"`,
      },
      {
        file: "prisma/schema.prisma",
        lang: "prisma",
        content: `datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model __TABLE__ {
  id         String   @id @default(uuid())
  user_id    String
  created_at DateTime @default(now())
}`,
      },
      {
        file: "terminal",
        lang: "bash",
        content: `# Pull the schema Pluto already created
npx prisma db pull

# Generate the typed client
npx prisma generate

# IMPORTANT: Prisma bypasses RLS (it connects as the DB owner).
# Use it server-side only, never expose DATABASE_URL to the browser.`,
      },
    ],
  },
  {
    id: "supabase-compat",
    name: "Supabase → Pluto",
    blurb_en: "Drop-in swap: the client surface is API-compatible, only the import and env change.",
    blurb_bn: "সরাসরি বদল: client API একই, শুধু import ও env বদলায়।",
    install: "npm uninstall @supabase/supabase-js && npm install @pluto/js",
    snippets: [
      {
        file: "src/lib/pluto.ts",
        lang: "diff",
        content: `- import { createClient } from "@supabase/supabase-js";
+ import { createClient } from "@pluto/js";

- export const supabase = createClient(
-   import.meta.env.VITE_SUPABASE_URL,
-   import.meta.env.VITE_SUPABASE_ANON_KEY,
- );
+ export const pluto = createClient(
+   import.meta.env.VITE_PLUTO_URL,
+   import.meta.env.VITE_PLUTO_ANON_KEY,
+ );
+ // keep old call sites working during the migration:
+ export const supabase = pluto;`,
      },
      {
        file: "terminal",
        lang: "bash",
        content: `# Rewrite remaining call sites
rg -l "supabase" src | xargs sed -i 's/supabase\\./pluto./g'

# Move the schema across with the Migrator (dashboard → Database import)
pg_dump --schema-only --no-owner "$SUPABASE_DB_URL" > supabase-schema.sql`,
      },
    ],
  },
  {
    id: "curl",
    name: "cURL / any language",
    blurb_en: "Raw HTTP contract — use from Go, Python, PHP, mobile, anywhere.",
    blurb_bn: "সরাসরি HTTP — Go, Python, PHP, mobile যেকোনো জায়গা থেকে।",
    install: "# no dependencies",
    snippets: [
      {
        file: "terminal",
        lang: "bash",
        content: `# Read (RLS applies)
curl "__API__/rest/v1/__TABLE__?select=*&limit=5" \\
  -H "apikey: __ANON__" \\
  -H "Authorization: Bearer __ANON__"

# Sign in
curl -X POST "__API__/auth/v1/token?grant_type=password" \\
  -H "apikey: __ANON__" -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"secret"}'

# Server-side write (bypasses RLS — never from a browser)
curl -X POST "__API__/rest/v1/__TABLE__" \\
  -H "apikey: __SERVICE__" -H "Authorization: Bearer __SERVICE__" \\
  -H "Content-Type: application/json" -d '{"title":"hello"}'`,
      },
    ],
  },
];
