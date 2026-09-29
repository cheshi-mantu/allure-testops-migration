# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- build
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json vitest.config.ts ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/mocks/package.json packages/mocks/
RUN npm ci --no-audit --no-fund
COPY packages packages
RUN npm run build

# ---------------------------------------------------------------- test (used by dev-compose.yml)
FROM build AS test
CMD ["npm", "test"]

# ---------------------------------------------------------------- fake TestRail and Allure TestOps (used by dev-compose.yml)
FROM node:22-alpine AS mocks
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/mocks/package.json packages/mocks/
RUN npm ci --omit=dev --workspace @atm/mocks --no-audit --no-fund
COPY --from=build /src/packages/mocks/dist packages/mocks/dist
USER node
EXPOSE 4001 4002
CMD ["node", "packages/mocks/dist/main.js"]

# ---------------------------------------------------------------- application
FROM node:22-alpine AS app
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    WEB_DIR=/app/packages/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
RUN npm ci --omit=dev --workspace @atm/server --no-audit --no-fund
COPY --from=build /src/packages/shared/dist packages/shared/dist
COPY --from=build /src/packages/server/dist packages/server/dist
COPY --from=build /src/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "packages/server/dist/index.js"]
