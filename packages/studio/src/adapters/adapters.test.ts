import { describe, expect, test } from 'bun:test'
import type { StudioEvent } from '../room-adapter'
import { BridgeRoom, type ChannelLike, devtoolsChannelName, isTelemetryEvent } from './bridge'
import { ObserverRoom } from './observer'

class FakeChannel implements ChannelLike {
  sent: unknown[] = []
  closed = false
  private cbs = new Set<(e: { data: unknown }) => void>()
  postMessage(m: unknown) {
    this.sent.push(m)
  }
  addEventListener(_t: 'message', cb: (e: { data: unknown }) => void) {
    this.cbs.add(cb)
  }
  removeEventListener(_t: 'message', cb: (e: { data: unknown }) => void) {
    this.cbs.delete(cb)
  }
  close() {
    this.closed = true
  }
  deliver(data: unknown) {
    for (const cb of this.cbs) cb({ data })
  }
}

const P = 'a'.repeat(64)
const Q = 'b'.repeat(64)

describe('BroadcastChannel bridge', () => {
  test('channel name', () => {
    expect(devtoolsChannelName('lobby')).toBe('beamhop-devtools:lobby')
  })

  test('receives bare and wrapped telemetry, hello and peers', async () => {
    const ch = new FakeChannel()
    const room = new BridgeRoom({ roomId: 'r', channel: () => ch })
    const got: StudioEvent[] = []
    room.subscribe((e) => got.push(e))
    await room.join()
    expect(ch.sent).toEqual([{ type: 'studio-hello' }])
    ch.deliver({ type: 'hello', self: P })
    ch.deliver({ type: 'rtt', at: 1, peer: Q, ms: 20 })
    ch.deliver({ type: 'telemetry', source: Q, event: { type: 'rtt', at: 2, peer: P, ms: 21 } })
    ch.deliver({ type: 'bogus', at: 3 })
    ch.deliver('nope')
    expect(got.map((e) => [e.source, e.seq])).toEqual([
      [P, 1],
      [Q, 2],
    ])
    // derived peers until the page sends a list
    expect(
      room
        .peers()
        .map((p) => p.pubkey)
        .sort(),
    ).toEqual([P, Q])
    ch.deliver({ type: 'peers', peers: [{ pubkey: P, isHost: true }] })
    expect(room.peers()).toEqual([{ pubkey: P, isHost: true }])
    await room.leave()
    expect(ch.closed).toBe(true)
    ch.deliver({ type: 'rtt', at: 4, peer: Q, ms: 1 })
    expect(room.history().length).toBe(2)
  })

  test('faults, identity and connection info are forwarded to the page', async () => {
    const ch = new FakeChannel()
    const room = new BridgeRoom({ roomId: 'r', channel: () => ch })
    await room.join()
    const f = await room.injectFault({ type: 'latency', ms: 100 })
    expect(ch.sent).toContainEqual({ type: 'fault', id: f.id, fault: { type: 'latency', ms: 100 } })
    expect(room.faults().length).toBe(1)
    await room.clearFault(f.id)
    expect(room.faults().length).toBe(0)
    expect(room.connectionInfo(P, Q)).toBeNull()
    ch.deliver({
      type: 'connection-info',
      source: P,
      peer: Q,
      info: { state: 'connected', path: 'direct', channels: [], candidatePairs: [] },
    })
    expect(room.connectionInfo(P, Q)?.path).toBe('direct')
    const identity = {
      kind: 'anonymous' as const,
      pubkey: P,
      label: 'a',
      attestation: { type: 'anonymous' as const },
    }
    // No admission answer from the page: forwarded after the timeout.
    const quiet = new BridgeRoom({ roomId: 'r', channel: () => ch, admissionTimeoutMs: 10 })
    await quiet.join()
    const res = await quiet.setIdentity(identity)
    expect(res.admitted).toBe(true)
    expect(ch.sent.some((m) => (m as { type: string }).type === 'identity')).toBe(true)
    // With an answer, the page's decision is returned.
    const pending = room.setIdentity(identity)
    ch.deliver({ type: 'admission', pubkey: P, admitted: false, reason: 'nope' })
    expect(await pending).toEqual({ admitted: false, reason: 'nope' })
  })

  test('isTelemetryEvent', () => {
    expect(isTelemetryEvent({ type: 'peer', at: 1, peer: P, event: 'join' })).toBe(true)
    expect(isTelemetryEvent({ type: 'host', at: 1, host: null })).toBe(true)
    expect(isTelemetryEvent({ type: 'peer' })).toBe(false)
    expect(isTelemetryEvent(null)).toBe(false)
  })
})

describe('observer adapter', () => {
  test('cannot inject faults; identities without a held session key are refused', async () => {
    const room = new ObserverRoom({ appId: 'a', roomId: 'r', relay: 'wss://x' })
    expect(ObserverRoom.available).toBe(true)
    await expect(room.injectFault({ type: 'kill', peer: P })).rejects.toThrow('not supported')
    const res = await room.setIdentity({
      kind: 'anonymous',
      pubkey: P,
      label: '',
      attestation: { type: 'anonymous' },
    })
    expect(res.admitted).toBe(false)
    expect(res.reason).toContain('session key')
  })
})
