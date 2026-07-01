FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=optional --no-audit --no-fund

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
RUN npx tsc -p tsconfig.json

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl \
    && addgroup -S pluto && adduser -S pluto -G pluto \
    && mkdir -p /var/lib/pluto/storage && chown -R pluto:pluto /var/lib/pluto
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chmod=0755 scripts/boot.sh /app/boot.sh
# copy raw SQL migrations so migrate.ts can find them at runtime
COPY src/db/migrations ./dist/db/migrations
USER pluto
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:${PORT:-8000}/readyz || exit 1
CMD ["/app/boot.sh"]
