# Next.js front-end. Build from web/:
#   docker build -t trajx-web --build-arg NEXT_PUBLIC_API_BASE=http://localhost:8000 web
# NEXT_PUBLIC_* values are inlined at BUILD time, and the browser (not this
# container) calls the API — so the URL must be reachable from the user's
# browser, not a docker-internal hostname like http://api:8000.

# ---- deps ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM node:20-alpine AS build
WORKDIR /app
ARG NEXT_PUBLIC_API_BASE=http://localhost:8000
ARG NEXT_PUBLIC_CARTO_API_KEY=
ENV NEXT_PUBLIC_API_BASE=$NEXT_PUBLIC_API_BASE \
    NEXT_PUBLIC_CARTO_API_KEY=$NEXT_PUBLIC_CARTO_API_KEY \
    NEXT_STANDALONE=1 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx next build

# ---- runtime ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
