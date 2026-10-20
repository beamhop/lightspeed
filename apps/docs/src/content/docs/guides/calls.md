---
title: Audio and video calls
description: Add media next to a room, mute, switch cameras, share the screen and show the path per peer.
sidebar:
  order: 5
---

:::caution[0.x, subject to change]
:::

The room API carries data only in 0.x: there is no `room.addStream` yet. (The WebRTC transport's
connections support media internally, but rooms do not expose it.) Calls therefore use one
`RTCPeerConnection` per peer for media and the room as its **signaling channel**: offers, answers
and ICE candidates travel as a reliable action, end-to-end encrypted and only between admitted
peers. This is what the [demo](/lightspeed/demo/)'s **Call** screen does (`apps/demo/src/net/beamhop.ts`).

Media needs WebRTC (the data relay carries no media), and in a mesh every participant sends its
stream to every other one, so keep video calls to a handful of people.

## Signaling over the room

```ts
import { action, any, defineProtocol } from '@beamhop/p2p'

type RtcSignal =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit | null }

export const protocol = defineProtocol({
  // …your other actions
  rtc: action(any<RtcSignal>(), { priority: 'high' }),
})
```

```ts
const pcs = new Map<Hex, RTCPeerConnection>()
const rtc = room.action('rtc')

function pcFor(peer: Hex): RTCPeerConnection {
  let pc = pcs.get(peer)
  if (pc) return pc
  pc = new RTCPeerConnection({ iceServers })
  pcs.set(peer, pc)
  pc.onicecandidate = (e) =>
    void rtc.send({ type: 'candidate', candidate: e.candidate?.toJSON() ?? null }, { to: peer })
  pc.ontrack = (e) => showTile(peer, e.streams[0] ?? new MediaStream([e.track]))
  return pc
}

async function call(peer: Hex, local: MediaStream) {
  const pc = pcFor(peer)
  for (const track of local.getTracks()) pc.addTrack(track, local)
  await pc.setLocalDescription(await pc.createOffer())
  await rtc.send({ type: 'offer', sdp: pc.localDescription!.sdp }, { to: peer })
}

rtc.onMessage(async (s, from) => {
  const pc = pcFor(from)
  if (s.type === 'offer') {
    await pc.setRemoteDescription({ type: 'offer', sdp: s.sdp })
    for (const track of local.getTracks()) pc.addTrack(track, local)
    await pc.setLocalDescription(await pc.createAnswer())
    await rtc.send({ type: 'answer', sdp: pc.localDescription!.sdp }, { to: from })
  } else if (s.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: s.sdp })
  } else if (s.candidate) {
    await pc.addIceCandidate(s.candidate)
  }
})

// Let the lower pubkey call, like the library does for data connections.
for (const p of room.peers) if (room.self.pubkey < p.pubkey) void call(p.pubkey, local)
room.onPeerLeave((p) => {
  pcs.get(p.pubkey)?.close()
  pcs.delete(p.pubkey)
})
```

## Mute and camera off

Disable tracks instead of removing them; no renegotiation needed and the peer sees black/silence:

```ts
for (const t of local.getAudioTracks()) t.enabled = !muted
```

## Switch camera, share screen

Replace the track in place on every sender:

```ts
async function replaceVideo(track: MediaStreamTrack) {
  for (const pc of pcs.values())
    for (const s of pc.getSenders()) if (s.track?.kind === 'video') await s.replaceTrack(track)
}

const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
const next = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cams[1].deviceId } } })
await replaceVideo(next.getVideoTracks()[0])

const screen = await navigator.mediaDevices.getDisplayMedia({ video: true })
await replaceVideo(screen.getVideoTracks()[0])
```

## Show the path

The data path per peer comes from the room's telemetry; the media path from the call's own
`RTCPeerConnection.getStats()` (selected candidate pair: `host`, `srflx` or `relay`):

```ts
room.telemetry.subscribe((e) => {
  if (e.type === 'path') badge(e.peer, e.path)   // 'direct' | 'turn' | 'relay' | 'memory'
})
```

The demo labels each tile with *direct (LAN)*, *direct (STUN)* or *TURN relay*.

## Testing

Chromium's `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` flags produce a test
pattern and a beep without permission prompts; the demo's Playwright suite uses them.
