# syntax=docker/dockerfile:1
# spec/19-deployment.md §3 — Debian-slim (not Alpine): pi's bash tool expects glibc + GNU userland.

# ---- build ----
FROM node:22-bookworm-slim AS build
# Corporate proxies: pass with --build-arg HTTP_PROXY=... (BuildKit needs them declared).
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
ARG HTTP_PROXY
ARG HTTPS_PROXY
ARG NO_PROXY
ENV NODE_ENV=production \
    PIUI_HOME=/data \
    PIUI_HOST=0.0.0.0 \
    PIUI_PORT=8787 \
    PIUI_CONTAINER=1 \
    PIUI_CLIENT_DIST=/app/client/dist
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git ripgrep less tini \
  && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --create-home --shell /bin/bash piui \
  && mkdir -p /data && chown piui:piui /data
WORKDIR /app
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/shared/dist   ./shared/dist
COPY --from=build /src/shared/package.json ./shared/
COPY --from=build /src/server/dist   ./server/dist
COPY --from=build /src/server/package.json ./server/
COPY --from=build /src/client/dist   ./client/dist
COPY --from=build /src/package.json  ./
USER piui
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","server/dist/index.js"]
