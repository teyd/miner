# syntax=docker/dockerfile:1
# The image is node plus one bundled file, dist/bin.mjs (research 03 §4). The bundle is plain
# JavaScript, so the build stage runs on the builder's own platform and only the runtime stage
# is per architecture: `docker buildx build --platform linux/amd64,linux/arm64 .` emulates
# nothing.

FROM --platform=$BUILDPLATFORM node:26.13.0-bookworm-slim AS build
WORKDIR /src
# Only bootstraps pnpm: it then pins itself and Node through devEngines in package.json.
RUN npm install --global pnpm@12.16.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && mkdir /volume

FROM node:26.13.0-alpine
COPY --from=build /src/dist/bin.mjs /app/bin.mjs
# An empty /data owned by `node` (uid and gid 1000), so a fresh named volume isn't root's. A COPY,
# not a RUN, so building for another architecture runs nothing in its emulator.
COPY --from=build --chown=1000:1000 /volume /data
USER node
# Logs stay on stderr for `docker logs`: JSON, or pretty under `docker run -t`. The log driver
# keeps them, so the miner's own file copy is off. TOKEN comes from the environment at run time.
ENV DATA_DIR=/data \
    LOG_FILE=false
VOLUME /data
# Waits for `miner status`, which is not built yet. Until then this check would mark every
# container unhealthy, so it stays commented out:
# HEALTHCHECK --interval=1m --timeout=10s --start-period=1m CMD ["node", "/app/bin.mjs", "status"]
ENTRYPOINT ["node", "/app/bin.mjs"]
CMD ["run"]
