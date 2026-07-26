# Multi-stage Next.js Dockerfile for the Pluto starter.
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time envs are baked into the client bundle; pass with --build-arg.
ARG NEXT_PUBLIC_PLUTO_URL
ARG NEXT_PUBLIC_PLUTO_ANON_KEY
ENV NEXT_PUBLIC_PLUTO_URL=$NEXT_PUBLIC_PLUTO_URL
ENV NEXT_PUBLIC_PLUTO_ANON_KEY=$NEXT_PUBLIC_PLUTO_ANON_KEY
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/public ./public 2>/dev/null || true
EXPOSE 3000
CMD ["npm", "run", "start"]
