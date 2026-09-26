FROM node:24-alpine

ARG SOURCE_URL
LABEL org.opencontainers.image.source=$SOURCE_URL

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/.data

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public

RUN mkdir -p /app/.data && chown node:node /app/.data

USER node
EXPOSE 3000
VOLUME ["/app/.data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('node:http').get('http://127.0.0.1:3000/api/auth/status', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "server.js"]
