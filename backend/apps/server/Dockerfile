# syntax=docker/dockerfile:1.7
# Multi-stage build for Pluto BaaS server.
# Target: small, non-root, prod-only-deps runtime image (~180 MB).
#
# Build:   docker build -t pluto/server:latest backend/apps/server
# Run:     docker run --rm -p 3000:3000 --env-file .env pluto/server:latest
#
# Notes:
# - Uses npm ci with package-lock.json for reproducible installs.
# - Runtime stage installs `--omit=dev` so devDependencies (tsx, tsc, vitest)
#   never ship to production.
# - argon2 is a native module: alpine needs python3/make/g++ in the build
#   stage. It ships as a prebuilt binary at runtime — no compiler needed there.
# - Runs as an unprivileged user (`pluto`) with a writable /tmp only.

# --- 1) deps: install ALL deps (including dev) for the build stage ---------
FROM node:20-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# --- 2) build: compile TypeScript ------------------------------------------
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

# --- 3) prod-deps: fresh install with only production deps -----------------
FROM node:20-alpine AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# --- 4) runtime: minimal, non-root -----------------------------------------
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS="--enable-source-maps"

RUN apk add --no-cache curl tini \
 && addgroup -S pluto && adduser -S pluto -G pluto \
 && mkdir -p /var/lib/pluto/storage /tmp/pluto \
 && chown -R pluto:pluto /var/lib/pluto /tmp/pluto

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build     /app/dist          ./dist
COPY package.json ./
# Raw SQL migrations must be reachable at runtime — migrate.ts resolves
# them relative to the compiled db/ directory.
COPY src/db/migrations ./dist/db/migrations
COPY --chmod=0755 scripts/boot.sh /app/boot.sh

USER pluto
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/readyz" || exit 1

# tini reaps zombies and forwards SIGTERM cleanly for graceful shutdown.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/app/boot.sh"]
