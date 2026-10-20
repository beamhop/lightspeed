# syntax=docker/dockerfile:1
# Beamhop relay image: ghcr.io/beamhop/relay
#   docker build -t ghcr.io/beamhop/relay .
#   docker run -p 443:443 -p 3478:3478 -p 3478:3478/udp -p 5349:5349 -p 50000-50100:50000-50100/udp \
#     -e BEAMHOP_TURN_EXTERNAL_IP=<public ip> -v beamhop:/data ghcr.io/beamhop/relay

ARG BUN_VERSION=1

# ---------------------------------------------------------------- build
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY . .
RUN bun install --frozen-lockfile
# Admin SPA (Vite) -> packages/relay-admin/dist, served at /admin
RUN bun run --cwd packages/relay-admin build
# Single self-contained relay binary for the build platform (linux-x64 or linux-arm64)
RUN bun build packages/relay/src/bin.ts --compile --minify --sourcemap --outfile /out/beamhop-relay

# ---------------------------------------------------------------- runtime
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --user-group --home-dir /data --shell /usr/sbin/nologin beamhop \
  && mkdir -p /data /app \
  && chown beamhop:beamhop /data
COPY --from=build /out/beamhop-relay /usr/local/bin/beamhop-relay
COPY --from=build /src/packages/relay-admin/dist /app/admin
COPY deploy/beamhop-relay.example.toml /app/beamhop-relay.example.toml

ENV BEAMHOP_DATA_DIR=/data \
    BEAMHOP_ADMIN_DIST_DIR=/app/admin \
    BEAMHOP_HTTP_PORT=443 \
    BEAMHOP_TURN_UDP_PORT=3478 \
    BEAMHOP_TURN_TCP_PORT=3478 \
    BEAMHOP_TURN_TLS_PORT=5349 \
    BEAMHOP_TURN_RELAY_PORT_MIN=50000 \
    BEAMHOP_TURN_RELAY_PORT_MAX=50100

# Docker lets unprivileged users bind <1024 inside the container
# (net.ipv4.ip_unprivileged_port_start=0 is the default since Docker 20.10).
USER beamhop
WORKDIR /data
VOLUME ["/data"]
# 443 HTTPS/WSS (Nostr, admin, data relay, Blossom), 3478 STUN/TURN, 5349 turns:, relayed range
EXPOSE 443/tcp 3478/tcp 3478/udp 5349/tcp 50000-50100/udp
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD ["/usr/local/bin/beamhop-relay", "--healthcheck"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/beamhop-relay"]
