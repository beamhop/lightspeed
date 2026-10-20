---
title: Audio and video calls
description: Add media to a room, mute, switch cameras, share the screen and show the path per peer.
sidebar:
  order: 5
---

:::caution[0.x, subject to change]
:::

Media rides on the same WebRTC connections as data. It needs the `webrtc` transport (the data
relay carries no media), and in a mesh every participant sends its stream to every other one, so
keep video calls to a handful of people.

## Start and stop

```ts
const local = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
room.addStream(local)                         // to everyone; pass a pubkey for one peer

room.onPeerStream((stream, peer) => {
  const video = document.createElement('video')
  video.srcObject = stream
  video.autoplay = true
  video.playsInline = true
  tiles.set(peer.pubkey, video)
})

// Hang up
room.removeStream(local)
for (const t of local.getTracks()) t.stop()
```

## Mute and camera off

Disable tracks instead of removing them; no renegotiation needed and the peer sees black/silence:

```ts
for (const t of local.getAudioTracks()) t.enabled = !muted
```

## Switch camera, share screen

Replace the track in place:

```ts
const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
const next = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cams[1].deviceId } } })
room.replaceTrack(local.getVideoTracks()[0], next.getVideoTracks()[0])

const screen = await navigator.mediaDevices.getDisplayMedia({ video: true })
room.replaceTrack(local.getVideoTracks()[0], screen.getVideoTracks()[0])
```

## Show the path

```ts
room.telemetry.subscribe((e) => {
  if (e.type === 'path') badge(e.peer, e.path, e.candidatePair)   // 'direct' via host/srflx, or 'turn'
})
```

The demo labels each tile with *direct (LAN)*, *direct (STUN)* or *TURN relay*.

## Testing

Chromium's `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` flags produce a test
pattern and a beep without permission prompts; the demo's Playwright suite uses them.
