import { describe, expect, test } from 'bun:test'
import { schnorr } from '@noble/curves/secp256k1'
import {
  authEventTemplate,
  bytesToHex,
  KIND_ADMIN_AUTH,
  KIND_NIP46,
  localSigner,
  nip44ConversationKey,
  nip44Decrypt,
  nip44Encrypt,
  nip44PaddedLen,
  nip46Signer,
  parseBunkerUri,
  verifyEvent,
} from './nostr'
import type { NostrEvent } from './types'

const S1 = `${'0'.repeat(63)}1`
const S2 = `${'0'.repeat(63)}2`

describe('NIP-44 v2', () => {
  test('conversation key matches the spec vector', () => {
    const ck = nip44ConversationKey(S1, bytesToHex(schnorr.getPublicKey(S2)))
    expect(bytesToHex(ck)).toBe('c41c775356fd92eadc63ff5a0dc1da211b268cbea22316767095b2871ea1412d')
  })

  test('conversation key is symmetric', () => {
    const a = nip44ConversationKey(S1, bytesToHex(schnorr.getPublicKey(S2)))
    const b = nip44ConversationKey(S2, bytesToHex(schnorr.getPublicKey(S1)))
    expect(bytesToHex(a)).toBe(bytesToHex(b))
  })

  test('encrypt/decrypt roundtrip and tamper detection', () => {
    const ck = nip44ConversationKey(S1, bytesToHex(schnorr.getPublicKey(S2)))
    for (const msg of ['a', 'hello bunker', 'x'.repeat(300), '🐰 unicode']) {
      const enc = nip44Encrypt(msg, ck)
      expect(nip44Decrypt(enc, ck)).toBe(msg)
    }
    const enc = nip44Encrypt('secret', ck)
    const bad = `${enc.slice(0, 20)}${enc[20] === 'A' ? 'B' : 'A'}${enc.slice(21)}`
    expect(() => nip44Decrypt(bad, ck)).toThrow()
  })

  test('padding sizes', () => {
    expect(nip44PaddedLen(1)).toBe(32)
    expect(nip44PaddedLen(32)).toBe(32)
    expect(nip44PaddedLen(33)).toBe(64)
    expect(nip44PaddedLen(257)).toBe(320)
  })
})

describe('events', () => {
  test('local signer produces verifiable auth event', async () => {
    const s = localSigner(S1)
    const e = await s.signEvent(
      authEventTemplate('abc', 'https://relay/api/admin/auth/nostr', 1_700_000_000_000),
    )
    expect(e.kind).toBe(KIND_ADMIN_AUTH)
    expect(e.created_at).toBe(1_700_000_000)
    expect(e.tags).toContainEqual(['challenge', 'abc'])
    expect(verifyEvent(e)).toBe(true)
    expect(verifyEvent({ ...e, content: 'tampered' })).toBe(false)
  })
})

describe('NIP-46', () => {
  test('parses bunker URIs', () => {
    const pk = 'ab'.repeat(32)
    expect(
      parseBunkerUri(`bunker://${pk}?relay=wss://r.example&relay=wss://r2.example&secret=s3`),
    ).toEqual({
      remotePubkey: pk,
      relays: ['wss://r.example', 'wss://r2.example'],
      secret: 's3',
    })
    expect(() => parseBunkerUri('bunker://nothex')).toThrow()
    expect(() => parseBunkerUri(`bunker://${pk}`)).toThrow(/relay/)
  })

  test('connects, gets pubkey and signs via a fake bunker', async () => {
    const bunker = localSigner(S2)
    const bunkerPub = await bunker.getPublicKey()
    const user = localSigner(`${'0'.repeat(63)}3`)
    const sent: string[] = []
    const methods: string[] = []
    let clientSub = ''
    // Fake relay socket that loops requests through a fake remote signer.
    const sock = {
      readyState: 1,
      onopen: null as ((e: unknown) => void) | null,
      onmessage: null as ((e: { data: unknown }) => void) | null,
      onclose: null as ((e: unknown) => void) | null,
      onerror: null as ((e: unknown) => void) | null,
      close() {},
      send(data: string) {
        sent.push(data)
        const msg = JSON.parse(data)
        if (msg[0] === 'REQ') clientSub = msg[1]
        if (msg[0] !== 'EVENT') return
        const req = msg[1] as NostrEvent
        expect(req.kind).toBe(KIND_NIP46)
        const ck = nip44ConversationKey(S2, req.pubkey)
        const body = JSON.parse(nip44Decrypt(req.content, ck))
        methods.push(body.method)
        void (async () => {
          let result = 'ack'
          if (body.method === 'connect') expect(body.params).toEqual([bunkerPub, 'sekret'])
          if (body.method === 'get_public_key') result = await user.getPublicKey()
          if (body.method === 'sign_event')
            result = JSON.stringify(await user.signEvent(JSON.parse(body.params[0])))
          const resp = await bunker.signEvent({
            kind: KIND_NIP46,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['p', req.pubkey]],
            content: nip44Encrypt(JSON.stringify({ id: body.id, result }), ck),
          })
          sock.onmessage?.({ data: JSON.stringify(['EVENT', clientSub, resp]) })
        })()
      },
    }
    setTimeout(() => sock.onopen?.({}), 0)
    const signer = await nip46Signer(`bunker://${bunkerPub}?relay=wss://fake&secret=sekret`, {
      createSocket: () => sock,
      timeoutMs: 2000,
    })
    expect(await signer.getPublicKey()).toBe(await user.getPublicKey())
    const ev = await signer.signEvent(authEventTemplate('chal', 'https://x/api/admin/auth/nostr'))
    expect(verifyEvent(ev)).toBe(true)
    expect(methods).toEqual(['connect', 'get_public_key', 'sign_event'])
    expect(JSON.parse(sent[0] as string)[0]).toBe('REQ')
  })
})
