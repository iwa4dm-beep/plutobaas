# Deploy a Lovable frontend against backend-joy

End-to-end guide: sign-in → data fetch → file upload, wired to your
self-hosted **backend-joy** (Pluto API) from a Lovable-generated frontend
that lives in GitHub. Covers Vercel, Netlify, and a plain Cloud VPS.

## 0. Prerequisites

- backend-joy running at a public HTTPS URL (e.g. `https://api.timescard.cloud`)
  — verify with `curl https://api.timescard.cloud/livez` → `{"status":"ok"}`.
- The dashboard's **workspace / project / anon key** created:
  Dashboard → Projects → **New project** → **Keys** → copy the `pk_anon_…` value.
- GitHub repo of your Lovable project (Plus menu → GitHub → Connect project).

## 1. Bootstrap DB & storage

Open **Dashboard → SQL** and paste [`examples/lovable-frontend/setup.sql`](../examples/lovable-frontend/setup.sql).
It creates `profiles`, `user_roles`, `notes`, a per-user `uploads` bucket, and
the `has_role()` helper — all with correct GRANTs + RLS policies.

## 2. Wire the frontend

In your Lovable project (locally or in Lovable's editor):

```bash
bun add @pluto/js
```

Copy from this repo into your frontend:

| Source (this repo)                                    | Destination in Lovable app        |
| ----------------------------------------------------- | --------------------------------- |
| `examples/lovable-frontend/pluto-client.ts`           | `src/lib/pluto.ts`                |
| `examples/lovable-frontend/auth-example.tsx`          | `src/components/AuthPanel.tsx`    |
| `examples/lovable-frontend/data-example.tsx`          | `src/components/NotesPanel.tsx`   |
| `examples/lovable-frontend/upload-example.tsx`        | `src/components/UploadPanel.tsx`  |
| `examples/lovable-frontend/.env.example`              | `.env` (fill in real values)      |

## 3. Environment variables

```bash
VITE_PLUTO_URL=https://api.timescard.cloud
VITE_PLUTO_ANON_KEY=pk_anon_xxxxxxxxxxxx
```

`VITE_*` values are baked into the browser bundle at build time — they're
publishable-safe. Never expose the `service_role` key.

## 4. Deploy the frontend

### Option A — Vercel

1. **Import Git Repository** → pick your Lovable repo.
2. Framework preset: **Vite**. Build command `bun run build`, output dir `dist`.
3. **Environment Variables** → paste the two `VITE_*` values (Production +
   Preview). Redeploy.
4. Your app is live at `https://<project>.vercel.app`.

### Option B — Netlify

1. **Add new site → Import from Git** → pick your Lovable repo.
2. Build command `bun run build`, publish directory `dist`.
3. **Site settings → Environment variables** → add the two `VITE_*` values.
4. Trigger a deploy. Netlify serves at `https://<project>.netlify.app`.

### Option C — Cloud VPS (TanStack Start server + nginx)

```bash
git clone git@github.com:<you>/<lovable-repo>.git app && cd app
printf 'VITE_PLUTO_URL=https://api.timescard.cloud\nVITE_PLUTO_ANON_KEY=pk_anon_xxx\n' > .env
sudo APP_DIR="$PWD" PUBLIC_URL=https://app.example.com/ bash ./deploy-frontend.sh
```

This project builds to `.output/server/index.mjs` + `.output/public/assets`, not
`dist/index.html`. Do **not** deploy it as a static SPA. The deploy script builds
with `NITRO_PRESET=node-server`, installs a systemd service, and configures nginx
as a reverse proxy while serving hashed `/assets/*` files with the correct MIME
types.

Minimal nginx shape:

```nginx
server {
  listen 443 ssl http2;
  server_name app.example.com;
  root /path/to/app/.output/public;
  location ^~ /assets/ { try_files $uri =404; }
  location / { proxy_pass http://127.0.0.1:3001; }
}
```

## 5. CORS, cookies, redirects — exact settings

### 5.1 CORS on backend-joy

In **Dashboard → Settings → CORS** add every origin the frontend ships from:

```
https://<project>.vercel.app
https://<project>.netlify.app
https://app.example.com
http://localhost:8080          # Lovable local preview
```

The registry is DB-backed (`admin.cors_origins`) and hot-reloads every 15s —
no API restart required. Allowed headers already include
`Content-Type, Authorization, apikey, x-client-info, prefer, range`.

### 5.2 Session storage

The `@pluto/js` client uses **localStorage** by default (`storageKey:
"pluto.auth.token"`) and attaches the bearer token as the `Authorization`
header on every request. No cookies, no CSRF surface, and no
`credentials: "include"` needed — leave `Access-Control-Allow-Credentials`
**off** on the API. The client refreshes the token automatically via
`autoRefreshToken: true`.

If you deploy backend-joy on a different eTLD from the frontend, keep the
localStorage strategy above. Only switch to cookie sessions if you need SSR
route protection; that requires:

- `Set-Cookie: SameSite=None; Secure; Domain=.example.com`
- `Access-Control-Allow-Credentials: true`
- `Access-Control-Allow-Origin` set to the exact origin (never `*`)
- `credentials: "include"` on every `fetch` from the frontend

### 5.3 Auth callback / redirect URLs

**Dashboard → Auth → URL Configuration**:

- **Site URL**: `https://app.example.com` (your primary frontend origin)
- **Additional Redirect URLs** — add one per environment:
  ```
  https://<project>.vercel.app/auth/callback
  https://<project>.netlify.app/auth/callback
  https://app.example.com/auth/callback
  http://localhost:8080/auth/callback
  ```

In client code:

```ts
await pluto.auth.signUp({
  email, password,
  options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
});

await pluto.auth.resetPasswordForEmail(email, {
  redirectTo: `${window.location.origin}/reset-password`,
});
```

Create a route at `/auth/callback` that reads the URL hash and calls
`pluto.auth.getSession()`; create `/reset-password` that calls
`pluto.auth.updateUser({ password })`.

## 6. Smoke test the full loop

```bash
# 1. anon key reaches the API + CORS is correct
curl -i -H "apikey: $VITE_PLUTO_ANON_KEY" \
     -H "Origin: https://app.example.com" \
     https://api.timescard.cloud/auth/v1/settings

# 2. front-end E2E — from the deployed site, in the browser console:
await pluto.auth.signUp({ email: 'test@example.com', password: 'test1234!' });
const { data } = await pluto.from('notes').insert({ title: 'hi', body: 'world' }).select();
await pluto.storage.from('uploads').upload(`${(await pluto.auth.getUser()).data.user.id}/hello.txt`, new Blob(['hi']));
```

If any request returns `403` with a CORS error, revisit **5.1**. If it returns
`401 { message: "JWT expired" }`, force a refresh: `await pluto.auth.refreshSession()`.

## 7. Troubleshooting

| Symptom                                       | Fix                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------- |
| `CORS: origin not allowed`                    | Add exact origin (scheme + host + port) in Dashboard → Settings → CORS |
| `Missing VITE_PLUTO_URL`                      | Env var not set on the hosting provider — redeploy after adding it   |
| Uploads 403                                   | Path must start with `<user_id>/…` — see `uploads_owner_write` policy |
| `duplicate route /tokens/v1/health` on boot   | Pull latest — fixed in commit registering the route once in health.ts |
