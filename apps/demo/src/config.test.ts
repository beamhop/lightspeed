import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_ICE_SERVERS,
  normalizeRelayUrl,
  parseRoomInput,
  readConfig,
  roomLink,
} from './config'
import { joinDemoRoom } from './p2p'
import { applyProgress, type Transfer } from './transfers'

describe('config', () => {
  test('defaults: three public relays, two STUN servers, no TURN', () => {
    const c = readConfig('')
    expect(c.relays).toEqual(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'])
    expect(DEFAULT_ICE_SERVERS.map((s) => s.urls)).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ])
    expect(JSON.stringify(DEFAULT_ICE_SERVERS)).not.toContain('turn:')
    expect(c.local).toBe(false)
    expect(c.identity).toBe('anonymous')
    expect(c.name).toMatch(/^[a-z]+-[a-z]+$/)
  })

  test('reads room, password, local and relays from the query', () => {
    const c = readConfig(
      '?room=abc&pw=s3&local=1&name=zed&relays=relay.example,https://r2.example/',
    )
    expect(c).toMatchObject({ roomId: 'abc', password: 's3', local: true, name: 'zed' })
    expect(c.relays).toEqual(['wss://relay.example', 'wss://r2.example'])
  })

  test('normalizes relay URLs', () => {
    expect(normalizeRelayUrl('relay.example')).toBe('wss://relay.example')
    expect(normalizeRelayUrl('https://relay.example/')).toBe('wss://relay.example')
    expect(normalizeRelayUrl('http://localhost:8080')).toBe('ws://localhost:8080')
    expect(normalizeRelayUrl('ftp://nope')).toBeNull()
    expect(normalizeRelayUrl('  ')).toBeNull()
  })

  test('room links round-trip through parseRoomInput', () => {
    const link = roomLink('https://beamhop.github.io/lightspeed/demo/?x=1#h', {
      roomId: 'r1',
      password: 'pw',
      local: true,
    })
    expect(link).toBe('https://beamhop.github.io/lightspeed/demo/?room=r1&pw=pw&local=1')
    expect(parseRoomInput(link)).toEqual({ roomId: 'r1', password: 'pw' })
    expect(parseRoomInput('plain-id')).toEqual({ roomId: 'plain-id' })
    expect(parseRoomInput('not a room!')).toBeNull()
    expect(parseRoomInput('https://example.com/no-room')).toBeNull()
  })
})

describe('transfers', () => {
  test('progress folds into one transfer with a row per peer', () => {
    let list: Transfer[] = []
    const base = { transferId: 't', direction: 'out' as const, name: 'f', mime: 'x', total: 10 }
    list = applyProgress(list, { ...base, peer: 'a', sent: 5, done: false }, () => 'u')
    list = applyProgress(list, { ...base, peer: 'b', sent: 10, done: true }, () => 'u')
    list = applyProgress(list, { ...base, peer: 'a', sent: 10, done: true }, () => 'u')
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0]?.perPeer ?? {})).toEqual(['a', 'b'])
    expect(list[0]?.perPeer.a?.done).toBe(true)
    expect(list[0]?.url).toBeUndefined()
    list = applyProgress(
      list,
      { ...base, direction: 'in', peer: 'c', sent: 10, done: true, blob: new Blob(['x']) },
      () => 'blob:1',
    )
    expect(list).toHaveLength(2)
    expect(list[0]?.url).toBe('blob:1')
  })
})

describe('joinDemoRoom', () => {
  test('local=1 selects the BroadcastChannel implementation', async () => {
    const room = await joinDemoRoom({ ...readConfig('?room=sel&local=1') })
    expect(room.mode).toBe('local')
    expect(room.notice).toBeUndefined()
    await room.leave()
  })
})
