FROM ghcr.io/shadowsocks/sslocal-rust:v1.25.0 AS shadowsocks
FROM node:24-bookworm-slim

ARG SOURCE_URL
LABEL org.opencontainers.image.source=$SOURCE_URL

ENV NODE_ENV=production \
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
COPY --chown=node:node public ./public

# Keep browser writes inside the existing volume, including on read-only stacks.
RUN mkdir -p /app/.data/browser-tmp && chown -R node:node /app/.data \
    && rm -rf /tmp && ln -s /app/.data/browser-tmp /tmp

ENV TMPDIR=/app/.data/browser-tmp \
    XDG_CACHE_HOME=/app/.data/browser-tmp/cache \
    XDG_CONFIG_HOME=/app/.data/browser-tmp/config

USER node
EXPOSE 3000
VOLUME ["/app/.data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:3000/api/auth/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
