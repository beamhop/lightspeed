---
title: Troubleshooting
description: NAT types, TURN diagnosis, Safari quirks and relay reachability.
---

Start with the telemetry: the demo's **Debug drawer** and Studio's **Connection detail** show the
signaling relays' state, each peer's connection state, the selected path (`direct`, `turn`,
`relay`) and the last signaling events. Most problems fall into one of the sections below.

## Peers never see each other

The announce step failed. Check, in order:

1. **Same room inputs.** `appId`, `roomId` and `password` must match exactly (they are hashed into
   the topic; a trailing space is a different room).
2. **Relay connectivity.** Every relay in the signaling list should be `open`. Corporate proxies
   often block WebSockets to unknown hosts; public relays also rate-limit and occasionally drop
   ephemeral kinds. Use at least three relays, or your own relay's realm.
3. **Clock skew.** Events older than 30 seconds are ignored. A device whose clock is minutes off
   will not see (or be seen by) others. Check the OS time sync.
4. **NIP-42 realms.** If you signal through `wss://relay.example/a/<appId>` and the realm requires
   AUTH, the signaling log shows `auth-required`. Make sure the identity is allowed by the realm
   policy.

## Peers see each other but never connect

Signaling works, ICE does not. The debug view shows the peer stuck in `connecting` and then
`disconnected`.

- **Symmetric NAT on both sides.** With STUN only, two symmetric NATs (common on mobile carriers and
  corporate networks) cannot find a direct path. Add TURN from your own relay, or enable the data
  relay (`relayTransport`) as the last rung of the ladder.
- **UDP blocked.** Some networks block all UDP. TURN over TCP (`turn:host:3478?transport=tcp`) or
  TLS (`turns:host:443`) gets through most of them; the data relay rides on HTTPS and works almost
  everywhere.
- **VPNs and privacy extensions** can hide host candidates or block WebRTC entirely.

### Which NAT am I behind?

| You see | Meaning |
|---|---|
| `srflx` candidates with the same public port for different STUN servers | Endpoint-independent mapping ("cone"): direct connections usually work |
| `srflx` candidates with different ports per STUN server | Symmetric NAT: needs TURN or the data relay against another symmetric NAT |
| No `srflx` candidates at all | UDP blocked or STUN unreachable |

## Diagnosing TURN

1. Mint credentials manually:
   ```sh
   curl -X POST -H "Authorization: Bearer $API_KEY" https://relay.example/a/my-app/turn-credentials
   ```
   A `401` means the API key is wrong; `404` means the app id does not exist.
2. Test the server with [Trickle ICE](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/)
   or `turnutils_uclient` from coturn using the returned username and credential. You should see
   `relay` candidates.
3. No relay candidates? Check that UDP 3478 and the allocation range (default 50000–50100/udp) are
   open in the firewall and the cloud security group, and that `turn.external_ip` is the public
   address when the relay runs behind 1:1 NAT (most clouds).
4. Credentials rejected after a while: they expire (`ttl`, default one hour) and stop working when
   the app's TURN secret is rotated. Clients refresh them on reconnect.
5. The admin UI's **TURN** screen lists live allocations with bytes per allocation; an allocation
   that exists but carries no bytes points at a permission problem on the peer side.

## Safari quirks

- **Data channels before media.** Safari only gathers host candidates after a `getUserMedia`
  permission grant; without it, it offers mDNS-obfuscated or no host candidates, so LAN-only
  connections may need STUN.
- **Backgrounding on iOS** suspends WebSockets and data channels within seconds. The library marks
  the peer `away` and resumes when the tab returns (sessions are keyed by identity), but long
  backgrounding ends in `leave`.
- **`maxRetransmits: 0` channels** may still deliver late messages on some versions; do not rely on
  unreliable channels for ordering.
- **Screen sharing** (`getDisplayMedia`) is unavailable on iOS.

## Relay reachability

- `GET https://relay.example/healthz` should return `200`.
- `curl -H 'Accept: application/nostr+json' https://relay.example/` returns the NIP-11 document.
- `wss://` connections failing while HTTPS works usually means a proxy that does not forward
  WebSocket upgrades. With Caddy, `reverse_proxy` handles upgrades by default.
- The relay must **not** sit behind Cloudflare's proxy (orange cloud): TURN cannot be proxied and
  long-lived WebSockets get cut.
- TLS errors on `turns:` usually mean the certificate does not include the TURN hostname.

## Still stuck?

Open an issue with the Debug drawer contents (it contains no message contents), the browser and OS
versions, and whether a relay of your own is involved.
