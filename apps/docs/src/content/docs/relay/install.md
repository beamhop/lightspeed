---
title: Install
description: Run beamhop-relay as a binary with systemd, as a Docker container, or with Docker Compose behind Caddy.
sidebar:
  order: 1
---

:::caution[0.x, subject to change]
The relay is pre-1.0. Config keys and CLI flags may change between minor versions; release notes
call out every change.
:::

`beamhop-relay` is one Bun process that serves a full Nostr relay, a STUN/TURN server, the Beamhop
data relay, Blossom media, Lightning payments and the admin UI. It is licensed **AGPL-3.0**. Apps
that only *use* a relay through `@beamhop/p2p` (MIT) are not affected by the AGPL.

**You need:** a Linux VPS with a public IPv4 (and ideally IPv6) address, a DNS name pointing at it,
and the ports from [Ports and NAT](../ports-and-nat/) open. 2 vCPU / 2 GB is plenty to start; the
reference deployment uses 4 vCPU / 8 GB. TURN needs the machine's real public address: do not put
it behind a load balancer or Cloudflare's proxy.

## Option 1: binary + systemd

```sh
# Download the binary for your platform (linux-x64, linux-arm64, darwin-arm64)
curl -fsSL -o /usr/local/bin/beamhop-relay \
  https://github.com/beamhop/lightspeed/releases/latest/download/beamhop-relay-linux-x64
chmod +x /usr/local/bin/beamhop-relay

# Or, with Bun installed: bunx beamhop relay init
sudo beamhop-relay init --domain relay.example.com --data /var/lib/beamhop
```

`init` writes `/etc/beamhop/beamhop-relay.toml`, a hardened systemd unit
(`beamhop-relay.service`, non-root user, `ProtectSystem=strict`, `CAP_NET_BIND_SERVICE` only), creates
the data directory and prints a one-time **bootstrap token**. Then:

```sh
sudo systemctl enable --now beamhop-relay
journalctl -u beamhop-relay -f
```

Open `https://relay.example.com/admin`, paste the bootstrap token and claim the first admin with
your Nostr key (NIP-07) or a password + TOTP.

## Option 2: Docker

```sh
docker run -d --name beamhop-relay --restart unless-stopped \
  -p 443:443 -p 3478:3478 -p 3478:3478/udp -p 5349:5349 \
  -p 50000-50100:50000-50100/udp \
  -v beamhop:/data \
  -v /etc/letsencrypt:/etc/letsencrypt:ro \
  -e BEAMHOP_SERVER_PUBLIC_URL=https://relay.example.com \
  -e BEAMHOP_TLS_CERT=/etc/letsencrypt/live/relay.example.com/fullchain.pem \
  -e BEAMHOP_TLS_KEY=/etc/letsencrypt/live/relay.example.com/privkey.pem \
  -e BEAMHOP_TURN_EXTERNAL_IP=203.0.113.10 \
  ghcr.io/beamhop/relay:latest

docker logs beamhop-relay | grep bootstrap
```

On Linux, `--network host` avoids Docker's userland proxy for the UDP range and performs better
under load; then the `-p` flags are not needed.

## Option 3: Docker Compose with Caddy (automatic HTTPS)

Caddy obtains and renews certificates and terminates TLS on 443. The relay serves plain HTTP to
Caddy and keeps `turns:` on 5349 with the same certificate, which it reads from Caddy's storage.

```yaml title="compose.yaml"
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
  relay:
    image: ghcr.io/beamhop/relay:latest
    restart: unless-stopped
    network_mode: host            # TURN needs the real addresses; host networking is simplest
    volumes:
      - beamhop:/data
      - caddy-data:/caddy:ro       # for the turns: certificate
    environment:
      BEAMHOP_SERVER_LISTEN: 127.0.0.1:8080
      BEAMHOP_SERVER_PUBLIC_URL: https://relay.example.com
      BEAMHOP_TLS_CERT: /caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/relay.example.com/relay.example.com.crt
      BEAMHOP_TLS_KEY: /caddy/caddy/certificates/acme-v02.api.letsencrypt.org-directory/relay.example.com/relay.example.com.key
      BEAMHOP_TURN_TLS_PORT: "5349"
volumes:
  caddy-data:
  beamhop:
```

```txt title="Caddyfile"
relay.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

Caddy forwards WebSocket upgrades automatically, so Nostr, the data relay and the admin stats stream
work unchanged.

## Verify

```sh
curl https://relay.example.com/healthz                                     # ok
curl -H 'Accept: application/nostr+json' https://relay.example.com/        # NIP-11 document
```

Then create an app in the admin UI ([Apps and realms](../apps-and-realms/)) and point the
[demo](/lightspeed/demo/)'s Debug drawer at your relay.

## Upgrading

Replace the binary (or pull the image) and restart. Migrations run on boot and refuse to downgrade;
config and data are forward-compatible within a major version. Take a backup first
([Backups](../backups/)).
