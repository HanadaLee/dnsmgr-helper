# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=dnsmgr-helper-npm,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline


FROM dependencies AS build

COPY VERSION tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN node --input-type=module -e \
      "import fs from 'node:fs'; const version = fs.readFileSync('VERSION', 'utf8').trim().replace(/^v/, ''); const packageVersion = JSON.parse(fs.readFileSync('package.json', 'utf8')).version; if (version !== packageVersion) throw new Error('VERSION (' + version + ') must match package.json (' + packageVersion + ')')" \
    && npm run build


FROM build AS verify

COPY config/dnsmgr-helper.example.json ./config/dnsmgr-helper.example.json
COPY test/ ./test/
RUN npm run config:check -- config/dnsmgr-helper.example.json \
    && npm run typecheck \
    && npm test


FROM node:22-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,id=dnsmgr-helper-npm-production,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --prefer-offline


FROM node:22-bookworm-slim AS runtime

ARG APP_VERSION=dev

LABEL org.opencontainers.image.title="dnsmgr-helper" \
      org.opencontainers.image.description="Compatibility BFF for a stock dnsmgr installation" \
      org.opencontainers.image.version="${APP_VERSION}"

ENV NODE_ENV=production \
    DNSMGR_HELPER_CONFIG=/app/config/dnsmgr-helper.json

WORKDIR /app

RUN --mount=type=cache,id=dnsmgr-helper-apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=dnsmgr-helper-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        tzdata

COPY --chown=node:node package.json package-lock.json VERSION ./
COPY --chown=node:node --from=production-dependencies /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node config/dnsmgr-helper.example.json ./config/dnsmgr-helper.example.json
COPY --chown=node:node deploy/docker-healthcheck.mjs ./deploy/docker-healthcheck.mjs

USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "/app/deploy/docker-healthcheck.mjs"]

CMD ["node", "dist/server.js"]
