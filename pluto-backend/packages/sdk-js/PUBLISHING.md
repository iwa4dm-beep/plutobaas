# Publishing @timescard/pluto-js to npm

The SDK is already served as a signed tarball from
`https://backend-joy.lovable.app/sdk/download/pluto-js-<version>.tgz` with a
matching SHA-256 in `manifest.json`. Publishing to the npm registry is
optional but recommended — it enables the canonical `npm i @timescard/pluto-js`
install flow.

## 1. One-time npm setup

1. Create a free npm account: <https://www.npmjs.com/signup>
2. Create (or join) the `@timescard` organisation on npm — scoped packages
   under `@timescard/*` must live in that org.
   - If the org name is taken, edit `pluto-backend/packages/sdk-js/package.json`
     and change `"name"` (e.g. `@your-org/pluto-js`), then update
     `SDK_NPM_NAME` in `src/routes/index.tsx`.
3. Generate an **Automation** access token (Account → Access Tokens →
   Generate → Automation). Copy it once.

## 2. Publishing manually (from your laptop)

```bash
cd pluto-backend/packages/sdk-js
npm login                       # first time only
npm run release                 # builds dist/ + publishes with --access public
```

`npm run release` runs `tsup` first (via `prepublishOnly` hook), so the
`dist/` output is always fresh.

## 3. Publishing from CI (recommended)

1. In GitHub → repo Settings → Secrets → Actions, add
   `NPM_TOKEN` = the automation token from step 1.
2. Two ways to trigger:
   - **Any GitHub Release** → publishes automatically.
   - **Manual dispatch** → Actions tab → "Build & release @timescard/pluto-js SDK"
     → Run workflow → set `publish_npm = true`.

The workflow bumps the tarball under `public/downloads/` in the same run, so
the direct-download install path and the npm registry install path stay in
sync — both point at the exact same bytes and the same SHA-256.

## 4. Bumping the version

```bash
cd pluto-backend/packages/sdk-js
npm version patch      # or minor / major
```

Then update `SDK_VERSION` in `src/routes/index.tsx` and run
`bash scripts/build-sdk-tarball.sh` so the manifest hash matches.

## 5. Verifying a published tarball

```bash
# Download the exact file the CDN serves
curl -fLO https://backend-joy.lovable.app/sdk/download/pluto-js-0.1.0.tgz

# Compare against the hash advertised in manifest.json
curl -s https://backend-joy.lovable.app/sdk/download/manifest.json | jq -r \
  '.files[] | select(.file=="pluto-js-0.1.0.tgz") | .sha256 + "  " + .file' \
  | sha256sum -c -
#   pluto-js-0.1.0.tgz: OK
```

The same hash is embedded in `SDK_TARBALL_SHA256` on the homepage.
