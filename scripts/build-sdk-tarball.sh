#!/usr/bin/env bash
# Rebuild @pluto/js and publish both a versioned + "latest" tarball under
# public/downloads. Run locally or from CI before deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="$ROOT/pluto-backend/packages/sdk-js"
OUT_DIR="$ROOT/public/downloads"

cd "$SDK_DIR"
VERSION="$(node -p "require('./package.json').version")"

echo "→ Building @pluto/js@${VERSION}"
bunx tsup src/index.ts --format esm,cjs --dts --clean --minify
npm pack --silent

mkdir -p "$OUT_DIR"
TARBALL="$(ls pluto-js-*.tgz | head -1)"
cp "$TARBALL" "$OUT_DIR/pluto-js-${VERSION}.tgz"
cp "$TARBALL" "$OUT_DIR/pluto-js-latest.tgz"
rm "$TARBALL"

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "name": "@pluto/js",
  "version": "${VERSION}",
  "latest": "/sdk/download/pluto-js-latest.tgz",
  "versioned": "/sdk/download/pluto-js-${VERSION}.tgz",
  "files": [
    { "version": "${VERSION}", "file": "pluto-js-${VERSION}.tgz" },
    { "version": "latest",    "file": "pluto-js-latest.tgz" }
  ]
}
EOF

echo "✔ Published pluto-js-${VERSION}.tgz + latest to public/downloads/"
