import { describe, expect, test } from 'bun:test'
import {
  FrameType,
  decodeFrame,
  decodeRelayEnvelope,
  encodeFrame,
  encodeRelayEnvelope,
  parseTurnUsername,
  roomKey,
  roomTopic,
  turnPassword,
  turnUsername,
} from './wire'

describe('wire', () => {
  test('room topic is stable and input-separated', () => {
    expect(roomTopic('app', 'room')).toHaveLength(64)
    expect(roomTopic('app', 'room')).toBe(roomTopic('app', 'room', ''))
    expect(roomTopic('ab', 'c')).not.toBe(roomTopic('a', 'bc'))
    expect(roomTopic('app', 'room', 'pw')).not.toBe(roomTopic('app', 'room'))
    expect(roomKey('app', 'room')).toHaveLength(32)
  })

  test('frame round-trip', () => {
    const payload = new Uint8Array([1, 2, 3])
    const f = decodeFrame(encodeFrame({ type: FrameType.Data, streamId: 513, payload }))
    expect(f).toEqual({ version: 1, type: FrameType.Data, streamId: 513, payload })
  })

  test('relay envelope round-trip', () => {
    const pk = 'ab'.repeat(32)
    const env = decodeRelayEnvelope(encodeRelayEnvelope(pk, new Uint8Array([9])))
    expect(env.pubkey).toBe(pk)
    expect([...env.body]).toEqual([9])
  })

  test('turn credentials', () => {
    const u = turnUsername(1700000000, 'app', 'ff'.repeat(32))
    expect(parseTurnUsername(u)).toEqual({ expiry: 1700000000, appId: 'app', pubkey: 'ff'.repeat(32) })
    // HMAC-SHA1("secret", "1700000000:app:ff..") is deterministic base64 of 20 bytes
    expect(turnPassword('secret', u)).toMatch(/^[A-Za-z0-9+/]{27}=$/)
  })
})
