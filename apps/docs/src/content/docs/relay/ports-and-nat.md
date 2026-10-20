---
title: Ports and NAT
description: Which ports to open, how big the TURN range should be, and running behind cloud 1:1 NAT.
sidebar:
  order: 4
---

:::caution[0.x, subject to change]
:::

| Port | Protocol | Use |
|---|---|---|
| 443 | TCP | HTTPS, WSS (Nostr, admin, data relay, Blossom); `turns:` when no proxy owns 443 |
| 3478 | UDP + TCP | STUN and `turn:` |
| 5349 | TCP | `turns:` when a proxy owns 443 |
| 50000–50100 | UDP | TURN relayed allocations (configurable) |
| 80 | TCP | ACME challenge and redirect, only when Caddy fronts the relay |

Open them in the host firewall **and** in your cloud provider's security group:

```sh
sudo ufw allow 443/tcp
sudo ufw allow 3478
sudo ufw allow 5349/tcp
sudo ufw allow 50000:50100/udp
```

## Sizing the relay port range

Each TURN allocation uses one UDP port from `turn.relay_ports`. A peer in a call typically holds one
allocation per connection that needs TURN, and most connections do not. 100 ports comfortably serve
a few hundred concurrent users; widen the range (and the firewall rule) if the admin overview shows
allocation failures.

## Behind 1:1 NAT (most clouds)

On AWS, GCP, Azure and many VPS providers the machine sees a private address while the internet
sees a public one. Tell the TURN server which address to advertise:

```toml
[turn]
external_ip = "203.0.113.10"     # the public IPv4
external_ip6 = "2001:db8::10"    # if you have IPv6
```

Without it, clients receive relay candidates with a private address and TURN silently fails.

## IPv6

Enable it. Many mobile networks are IPv6-first, and IPv6 paths often avoid NAT entirely. The relay
listens on both families and allocates IPv6 relayed addresses when the client asks.

## Docker networking

The default bridge network NATs every UDP packet through a userland proxy, which costs CPU and
breaks for large port ranges. Use `network_mode: host` (Linux) for the relay container, or publish
the exact range and set `external_ip`.
