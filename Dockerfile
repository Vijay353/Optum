# EvidenceBridge: one Node process serving the built UI, the API and the four simulators
# on one origin. Stateful single instance: one writer container, SQLite on a mounted volume.
# Base image pinned to the Node version the project is tested on (22.22.0). Verify the tag
# and architecture (linux/amd64 or linux/arm64) at build time.
ARG NODE_IMAGE=node:22.22.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run check:bundle && npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    EB_HOST=0.0.0.0 \
    PORT=8787 \
    EB_DB_PATH=/data/evidencebridge.sqlite \
    EB_MODE=SIMULATED \
    EB_EXTRACTOR=fixture
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json /app/tsconfig.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/scripts ./scripts
# The database lives only on the mounted volume. WAL sidecar files stay next to it.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.EB_PORT||process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "server/index.ts"]
