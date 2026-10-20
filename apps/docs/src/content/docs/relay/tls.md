---
title: TLS
description: Certificates for HTTPS, WSS and turns:, with or without Caddy in front.
sidebar:
  order: 3
---

:::caution[0.x, subject to change]
:::

The relay needs TLS for three things: HTTPS/WSS (Nostr, admin, data relay, Blossom) and `turns:`
(TURN over TLS, which gets through firewalls that only allow 443). v1 reads a certificate and key
from files; ACME is delegated to a tool that is good at it.

## Relay terminates TLS (no proxy)

```toml
[server]
listen = "0.0.0.0:443"

[tls]
cert = "/etc/letsencrypt/live/relay.example.com/fullchain.pem"
key = "/etc/letsencrypt/live/relay.example.com/privkey.pem"
```

Obtain the certificate with certbot or lego (`certbot certonly --standalone -d relay.example.com`,
which needs port 80 briefly). The relay **watches both files and reloads** them on change, so renewal
needs no restart. Give the relay's user read access to the key (for certbot:
`chgrp beamhop /etc/letsencrypt/{live,archive}` and `chmod 750`).

In this mode the relay also serves `turns:` on 443 by detecting TLS ClientHellos that carry STUN, and
on 5349.

## Caddy terminates TLS

With [Caddy in front](../install/#option-3-docker-compose-with-caddy-automatic-https), Caddy owns 443
and renews certificates automatically. The relay listens on `127.0.0.1:8080` without TLS for HTTP,
and keeps `turns:` on **5349** using the certificate from Caddy's storage (the same file watching
applies). Clients get `turns:relay.example.com:5349` in their ICE servers.

## Checks

```sh
openssl s_client -connect relay.example.com:443 -servername relay.example.com </dev/null | head
openssl s_client -connect relay.example.com:5349 -servername relay.example.com </dev/null | head
```

The admin UI's **Settings** screen has a "Test TLS" button and the overview raises an alert 14 days
before the certificate expires.

## Do not

- Put the relay behind Cloudflare's proxy or any HTTP load balancer that cannot pass UDP. TURN and
  long-lived WebSockets need a direct path.
- Use a certificate that does not cover the hostname clients use for `turns:`.
