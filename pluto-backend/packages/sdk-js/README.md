# @pluto/js

Official JavaScript / TypeScript client for **Pluto BaaS**.
Supabase-compatible API — if you know `@supabase/supabase-js`, you already know this.

```bash
npm i @pluto/js
```

## Usage

```ts
import { createClient } from '@pluto/js'

const pluto = createClient(
  'https://api.your-domain.com',
  'pk_publishable_key_here'
)

// --- Auth ---
await pluto.auth.signUp({ email: 'a@b.c', password: 'secret1234' })
const { data, error } = await pluto.auth.signInWithPassword({ email, password })
pluto.auth.onAuthStateChange((event, session) => { console.log(event, session) })
await pluto.auth.signOut()

// --- Database ---
const { data: posts } = await pluto
  .from('posts')
  .select('id, title, author_id')
  .eq('published', true)
  .order('created_at', { ascending: false })
  .limit(20)

await pluto.from('posts').insert({ title: 'Hello', body: '...' })
await pluto.from('posts').update({ published: true }).eq('id', 42)
await pluto.from('posts').upsert({ id: 42, title: 'x' }, { onConflict: 'id' })
await pluto.from('posts').delete().eq('id', 42)

// --- RPC ---
const { data } = await pluto.rpc('increment_counter', { by: 1 })

// --- Storage ---
await pluto.storage.from('avatars').upload('me.png', file)
const { data: url } = pluto.storage.from('avatars').getPublicUrl('me.png')

// --- Realtime ---
pluto.channel('room-1')
  .on('postgres_changes', { event: 'INSERT', table: 'messages' }, (p) => console.log(p))
  .subscribe()
```

## Framework support

Works in React, Next.js, TanStack Start, Vue, Svelte, vanilla JS, React Native, and any modern runtime with `fetch` and `WebSocket`. SSR-safe (auto-detects `localStorage`, falls back to in-memory).

## Migrating from Supabase

Most calls are drop-in. Replace:

```diff
- import { createClient } from '@supabase/supabase-js'
+ import { createClient } from '@pluto/js'
```

## License

MIT
