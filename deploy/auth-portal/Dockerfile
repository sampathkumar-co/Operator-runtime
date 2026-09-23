FROM node:22.23.2-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs pairing.mjs ./
RUN chown -R node:node /app
USER node
ENV PORT=8090 PORTAL_USERS_FILE=/data/users_database.yml
EXPOSE 8090
CMD ["node", "server.mjs"]
