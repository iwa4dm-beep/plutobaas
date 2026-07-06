# @pluto/js

Official JavaScript / TypeScript SDK for [Pluto](https://api.timescard.cloud) — a Supabase-compatible BaaS.

```bash
npm install @pluto/js
```

```ts
import { createClient } from '@pluto/js';

const pluto = createClient('https://api.timescard.cloud', 'pk_live_...');

// Full self-serve onboarding in one call
const { data } = await pluto.onboarding.signupFull({
  email: 'you@example.com',
  password: '...',
  domain: 'https://yourapp.com',
  seed_demo: true,
});

// Then use like Supabase
await pluto.from('posts').select('*').eq('published', true);
await pluto.storage.from('avatars').upload('me.png', file);
pluto.channel('room').on('postgres_changes', {...}, cb).subscribe();
```

Full docs: <https://backend-joy.lovable.app/docs/sdk>

## API surface

| Namespace          | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `pluto.auth`       | sign in/up/out, session, `onAuthStateChange`     |
| `pluto.from(t)`    | REST query builder (`select/insert/update/delete`)|
| `pluto.rpc(fn)`    | call Postgres functions                          |
| `pluto.storage`    | file upload, public/signed URLs                  |
| `pluto.realtime`   | channels, presence, broadcast, CDC               |
| `pluto.onboarding` | `signupFull`, `acceptInvite`, `createInvite`     |
| `pluto.domains`    | `list`, `add`, `remove` — auto-CORS              |

## License

MIT
