#!/usr/bin/env bash
# Rebuild @timescard/pluto-js and publish both a versioned + "latest" tarball
# under public/downloads, with SHA-256 hashes embedded in manifest.json.
# Run locally or from CI before deploy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SDK_DIR="$ROOT/pluto-backend/packages/sdk-js"
OUT_DIR="$ROOT/public/downloads"

cd "$SDK_DIR"
NAME="$(node -p "require('./package.json').name")"
VERSION="$(node -p "require('./package.json').version")"

echo "→ Building ${NAME}@${VERSION}"
bunx tsup src/index.ts --format esm,cjs --dts --clean --minify
npm pack --silent

mkdir -p "$OUT_DIR"
TARBALL="$(ls *.tgz | head -1)"
cp "$TARBALL" "$OUT_DIR/pluto-js-${VERSION}.tgz"
cp "$TARBALL" "$OUT_DIR/pluto-js-latest.tgz"
rm "$TARBALL"

HASH_V="$(sha256sum "$OUT_DIR/pluto-js-${VERSION}.tgz" | awk '{print $1}')"
HASH_L="$(sha256sum "$OUT_DIR/pluto-js-latest.tgz"   | awk '{print $1}')"

cat > "$OUT_DIR/manifest.json" <<EOF
{
  "name": "${NAME}",
  "npm": "https://www.npmjs.com/package/${NAME}",
  "version": "${VERSION}",
  "latest": "/sdk/download/pluto-js-latest.tgz",
  "versioned": "/sdk/download/pluto-js-${VERSION}.tgz",
  "algorithm": "sha256",
  "files": [
    {
      "version": "${VERSION}",
      "file": "pluto-js-${VERSION}.tgz",
      "url": "/sdk/download/pluto-js-${VERSION}.tgz",
      "sha256": "${HASH_V}"
    },
    {
      "version": "latest",
      "file": "pluto-js-latest.tgz",
      "url": "/sdk/download/pluto-js-latest.tgz",
      "sha256": "${HASH_L}"
    }
  ]
}
EOF

echo "✔ Published ${NAME}@${VERSION} tarball + latest to public/downloads/"
echo "  sha256 (${VERSION}): ${HASH_V}"
echo "  sha256 (latest):    ${HASH_L}"
echo
echo "To publish to npm registry:"
echo "  cd pluto-backend/packages/sdk-js && npm run release"
