FROM node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

WORKDIR /opt/operator
ENV NODE_ENV=production

COPY apps/mcp-server/package.json apps/mcp-server/package-lock.json ./apps/mcp-server/
COPY apps/relay-server/package.json apps/relay-server/package-lock.json ./apps/relay-server/
RUN npm ci --prefix apps/mcp-server --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm ci --prefix apps/relay-server --omit=dev --ignore-scripts --no-audit --no-fund

COPY src ./src
COPY apps/mcp-server/src ./apps/mcp-server/src
COPY apps/relay-server/src ./apps/relay-server/src
COPY deploy/public-edge/supervisor.mjs deploy/public-edge/healthcheck.mjs deploy/public-edge/http-probe.mjs ./deploy/public-edge/

RUN mkdir -p /var/lib/operator-relay \
 && chown -R node:node /var/lib/operator-relay /opt/operator

USER node
EXPOSE 47200 8788 8789
VOLUME ["/var/lib/operator-relay"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "deploy/public-edge/healthcheck.mjs"]
ENTRYPOINT ["node", "deploy/public-edge/supervisor.mjs"]