FROM ghcr.io/shadowsocks/sslocal-rust:v1.25.0 AS shadowsocks
FROM node:24-bookworm-slim

ARG SOURCE_URL
ARG BUILD_REVISION=unknown
LABEL org.opencontainers.image.source=$SOURCE_URL

ENV NODE_ENV=production \
    MONITOR_BUILD_REVISION=${BUILD_REVISION} \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/.data \
    MONITOR_BROWSER_EXECUTABLE=/usr/bin/chromium \
    MONITOR_SS_EXECUTABLE=/usr/local/bin/sslocal

RUN apt-get update && apt-get install -y --no-install-recommends chromium xvfb xauth fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=shadowsocks /usr/bin/sslocal /usr/local/bin/sslocal
COPY third_party/shadowsocks-LICENSE /usr/share/doc/shadowsocks/LICENSE
RUN /usr/local/bin/sslocal --version

WORKDIR /app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node automation ./automation
COPY --chown=node:node public ./public

# Durable accounts/orders stay in .data; transient Chromium/proxy writes use /tmp.
# compose mounts /tmp as bounded tmpfs; plain docker also works with writable /tmp.
RUN mkdir -p /app/.data && chown node:node /app/.data
ENV TMPDIR=/tmp \
    MONITOR_TEMP_DIR=/tmp/webhook-radar \
    XDG_CACHE_HOME=/tmp/webhook-radar/cache \
    XDG_CONFIG_HOME=/tmp/webhook-radar/config

USER node
EXPOSE 3000
VOLUME ["/app/.data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:3000/api/auth/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
