# Phase E — Preview vs Production

Every project gets two symlinks under `/var/lib/pluto/sites/<workspaceId>/`:

| symlink   | served on                             | flipped by         |
|-----------|---------------------------------------|--------------------|
| `preview` | `<slug>-dev.app.timescard.cloud`      | every `/unpack`    |
| `current` | `<slug>.app.timescard.cloud`          | explicit `/publish` |

This mirrors how Lovable and Vercel separate "latest build" from "what
the public sees". Owners iterate on `-dev`, click **Publish**, and only
then does the production URL update.

## Sandbox-worker API

```
POST /unpack     { workspaceId, slug?, bucket, key, env?, channel? }
                 channel: "preview" (default) | "production"
POST /publish    { workspaceId } | { slug }
                 → flips preview symlink into `current` atomically
POST /unpublish  { workspaceId } | { slug }
                 → removes `current` (production goes dark, preview stays)
GET  /resolve/:slug
GET  /status/:workspaceId
POST /env        { workspaceId|slug, env, merge? }   # hot rotation
```

All mutating endpoints require the `x-sandbox-secret` header.

## Nginx routing

The wildcard vhost (`deploy/nginx/wildcard-app.conf`) uses two maps:

```nginx
map $host $pluto_ws_slug {
    default "";
    "~^(?<slug>[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?)(?:-dev)?\.app\.timescard\.cloud$" $slug;
}
map $host $pluto_channel {
    default "current";
    "~^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?-dev\.app\.timescard\.cloud$" "preview";
}
root /var/lib/pluto/sites/$pluto_ws_slug/$pluto_channel;
```

A response header `X-Pluto-Channel: preview|current` is set so the app
can render a "Preview build" banner or hide analytics on `-dev`.

## Publish flow (dashboard)

1. User pushes a build → dashboard calls `/unpack` with
   `channel="preview"`.
2. Preview URL `https://<slug>-dev.app.timescard.cloud` updates instantly.
3. When happy, user clicks **Publish** → dashboard calls `/publish`
   with the same slug. `current` now points to the same release dir the
   preview does; `https://<slug>.app.timescard.cloud` goes live.
4. Rollback: call `/publish` again with a previous `release-*` id, or
   call `/unpublish` to hide production entirely.

## Migration notes

- Existing projects that only have `current` continue to work — nginx
  falls back to `current` when the host lacks the `-dev` suffix, and
  `/unpack` from before Phase E always wrote `current`. Post-Phase-E,
  new unpacks default to `preview`, so first-time projects will not have
  a production URL until they click **Publish**.
- The manifest split (`preview.json` / `current.json`) is additive;
  `current.json` still exists and mirrors the latest write for
  backward-compatible `/status/:workspaceId` responses.

## Frontend integration (leave as a follow-up for the operator)

The Projects → Deploy panel (`dashboard.pluto-deploy.tsx`) needs two new
buttons wired to `/publish` and `/unpublish`. The preview channel URL
should be surfaced next to the production URL in the projects list,
using the pattern `https://<slug>-dev.app.timescard.cloud`.
