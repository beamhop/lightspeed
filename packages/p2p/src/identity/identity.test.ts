import { describe, expect, test } from 'bun:test'
import {
  getConversationKey,
  decrypt as nip44Decrypt,
  encrypt as nip44Encrypt,
} from '../crypto/nip44'
import { encodeNsec, finalizeEvent, type NostrEvent, verifyEvent } from '../crypto/nostr'
import type { Unsubscribe } from '../types'
import { randomBytes } from '../util/bytes'
import { KIND_NIP46 } from '../wire'
import { anonymous, memoryKeyStorage } from './anonymous'
import { issueCapability, verifyCapability } from './capability'
import { generateSecretKey, getPublicKey } from './key'
import {
  type Nip46Transport,
  nip46Signer,
  nostr,
  parseBunkerUrl,
  verifyNostrAttestation,
} from './nostr'
import { oidc, publicJwk, signAttestationCert, staticJwks, verifyAttestation } from './oidc'

describe('anonymous()', () => {
  test('ephemeral keys differ; identities can encrypt to each other', async () => {
    const a = await anonymous().load()
    const b = await anonymous().load()
    expect(a.pubkey).not.toBe(b.pubkey)
    expect(a.attestations).toEqual([{ type: 'anonymous' }])
    const ct = await a.encrypt(b.pubkey, 'hello')
    expect(await b.decrypt(a.pubkey, ct)).toBe('hello')
    expect(await a.conversationKey(b.pubkey)).toEqual(await b.conversationKey(a.pubkey))
  })

  test('persist reuses the stored key', async () => {
    const storage = memoryKeyStorage()
    const a = await anonymous({ persist: true, storage }).load()
    const b = await anonymous({ persist: true, storage }).load()
    const c = await anonymous({ persist: 'other', storage }).load()
    expect(a.pubkey).toBe(b.pubkey)
    expect(c.pubkey).not.toBe(a.pubkey)
  })

  test('persist without IndexedDB degrades to ephemeral', async () => {
    const a = await anonymous({ persist: true }).load()
    expect(a.pubkey).toHaveLength(64)
  })
})

describe('nostr()', () => {
  test('nsec signs a session attestation', async () => {
    const userSk = generateSecretKey()
    const id = await nostr({ nsec: encodeNsec(userSk) }).load()
    const att = id.attestations[0]
    expect(att?.type).toBe('nostr')
    if (att?.type !== 'nostr') throw new Error()
    expect(att.pubkey).toBe(getPublicKey(userSk))
    expect(id.nostrPubkey).toBe(att.pubkey)
    expect(verifyNostrAttestation(att, id.pubkey)).toBe(true)
    expect(verifyNostrAttestation(att, getPublicKey(generateSecretKey()))).toBe(false)
    const r = await verifyAttestation(att, id.pubkey)
    expect(r).toEqual({ ok: true, type: 'nostr', nostrPubkey: att.pubkey })
  })

  test('NIP-07 extension object', async () => {
    const userSk = generateSecretKey()
    const ext = {
      getPublicKey: async () => getPublicKey(userSk),
      signEvent: async (e: Parameters<typeof finalizeEvent>[0]) => finalizeEvent(e, userSk),
    }
    const id = await nostr({ extension: ext }).load()
    expect(id.nostrPubkey).toBe(getPublicKey(userSk))
  })

  test('NIP-46 bunker over an injected transport', async () => {
    // In-memory "relay".
    const subs = new Set<{ p: string; cb: (e: NostrEvent) => void }>()
    const relay = {
      publish(e: NostrEvent) {
        expect(verifyEvent(e)).toBe(true)
        const p = e.tags.find((t) => t[0] === 'p')?.[1]
        for (const s of subs) if (s.p === p) queueMicrotask(() => s.cb(e))
      },
      subscribe(p: string, cb: (e: NostrEvent) => void): Unsubscribe {
        const s = { p, cb }
        subs.add(s)
        return () => subs.delete(s)
      },
    }
    // Fake bunker holding the user key.
    const userSk = generateSecretKey()
    const bunkerSk = generateSecretKey()
    const bunkerPk = getPublicKey(bunkerSk)
    let connectedWith: string | undefined
    relay.subscribe(bunkerPk, (e) => {
      const ck = getConversationKey(bunkerSk, e.pubkey)
      const req = JSON.parse(nip44Decrypt(e.content, ck)) as {
        id: string
        method: string
        params: string[]
      }
      let result: string
      if (req.method === 'connect') {
        connectedWith = req.params[1]
        result = 'ack'
      } else if (req.method === 'get_public_key') result = getPublicKey(userSk)
      else if (req.method === 'sign_event')
        result = JSON.stringify(finalizeEvent(JSON.parse(req.params[0] as string), userSk))
      else result = ''
      relay.publish(
        finalizeEvent(
          {
            kind: KIND_NIP46,
            created_at: 0,
            tags: [['p', e.pubkey]],
            content: nip44Encrypt(JSON.stringify({ id: req.id, result }), ck),
          },
          bunkerSk,
        ),
      )
    })
    const transport: Nip46Transport = {
      publish: async (e) => relay.publish(e),
      subscribe: (f, cb) => relay.subscribe(f['#p'][0] as string, cb),
    }
    const url = parseBunkerUrl(`bunker://${bunkerPk}?relay=wss://r.example&secret=s3cret`)
    expect(url).toEqual({ remotePubkey: bunkerPk, relays: ['wss://r.example'], secret: 's3cret' })
    const signer = nip46Signer({
      transport,
      remotePubkey: url.remotePubkey,
      secret: url.secret,
      timeoutMs: 2000,
    })
    const id = await nostr({ bunker: signer }).load()
    expect(connectedWith).toBe('s3cret')
    expect(id.nostrPubkey).toBe(getPublicKey(userSk))
    signer.close()
  })
})

describe('oidc()', () => {
  for (const alg of ['ES256', 'EdDSA'] as const) {
    test(`cert verification (${alg})`, async () => {
      const priv = randomBytes(32)
      priv[0] = 1 // keep the scalar below the P-256 order
      const jwks = staticJwks({ 'https://auth.example': { keys: [publicJwk(alg, priv, 'k1')] } })
      const id = await oidc({
        getCert: (pubkey) =>
          signAttestationCert({
            alg,
            privateKey: priv,
            kid: 'k1',
            iss: 'https://auth.example',
            sub: 'user-42',
            pubkey,
          }),
      }).load()
      const att = id.attestations[0]
      if (att?.type !== 'oidc') throw new Error()
      expect(await verifyAttestation(att, id.pubkey, { jwks })).toEqual({
        ok: true,
        type: 'oidc',
        subject: 'user-42',
        issuer: 'https://auth.example',
      })
      // Bound to the session pubkey.
      const other = getPublicKey(generateSecretKey())
      expect((await verifyAttestation(att, other, { jwks })).ok).toBe(false)
      // Expired.
      expect(
        (
          await verifyAttestation(att, id.pubkey, {
            jwks,
            now: Math.floor(Date.now() / 1000) + 7200,
          })
        ).ok,
      ).toBe(false)
      // Issuer filter.
      expect((await verifyAttestation(att, id.pubkey, { jwks, issuers: ['https://x'] })).ok).toBe(
        false,
      )
      // Wrong key.
      const wrong = staticJwks({
        'https://auth.example': { keys: [publicJwk(alg, randomBytes(32).fill(2), 'k1')] },
      })
      expect((await verifyAttestation(att, id.pubkey, { jwks: wrong })).ok).toBe(false)
    })
  }

  test('RS256 via WebCrypto', async () => {
    const kp = (await crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as Record<string, unknown>
    const pubkey = getPublicKey(generateSecretKey())
    const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
    const h = b64u(new TextEncoder().encode(JSON.stringify({ alg: 'RS256' })))
    const now = Math.floor(Date.now() / 1000)
    const p = b64u(
      new TextEncoder().encode(
        JSON.stringify({ v: 1, iss: 'i', sub: 's', pubkey, iat: now, exp: now + 60 }),
      ),
    )
    const sig = new Uint8Array(
      await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        kp.privateKey,
        new TextEncoder().encode(`${h}.${p}`),
      ),
    )
    const r = await verifyAttestation({ type: 'oidc', jws: `${h}.${p}.${b64u(sig)}` }, pubkey, {
      jwks: staticJwks({ i: { keys: [{ ...jwk, kty: 'RSA' }] } }),
    })
    expect(r.ok).toBe(true)
  })
})

describe('capability tokens', () => {
  test('issue + verify', async () => {
    const appKey = generateSecretKey()
    const app = getPublicKey(appKey)
    const peer = getPublicKey(generateSecretKey())
    const tok = await issueCapability(appKey, {
      room: 'ab'.repeat(32),
      pubkey: peer,
      caps: ['join', 'debug'],
    })
    expect(verifyCapability(tok, { room: 'ab'.repeat(32), pubkey: peer, issuers: [app] })).toEqual({
      ok: true,
      caps: ['join', 'debug'],
    })
    expect(verifyCapability(tok, { room: 'cd'.repeat(32), pubkey: peer, issuers: [app] }).ok).toBe(
      false,
    )
    expect(verifyCapability(tok, { room: 'ab'.repeat(32), pubkey: app, issuers: [app] }).ok).toBe(
      false,
    )
    expect(verifyCapability(tok, { room: 'ab'.repeat(32), pubkey: peer, issuers: [] }).ok).toBe(
      false,
    )
    expect(verifyCapability(tok, { room: 'ab'.repeat(32), pubkey: peer, dev: true }).ok).toBe(true)
    expect(
      verifyCapability(
        { ...tok, caps: ['join', 'debug', 'admin'] },
        { room: 'ab'.repeat(32), pubkey: peer, dev: true },
      ).ok,
    ).toBe(false)
    const host = await anonymous().load()
    const wild = await issueCapability(host, {
      room: '*',
      pubkey: peer,
      caps: ['debug'],
      ttlS: -10,
    })
    expect(
      verifyCapability(wild, { room: 'ab'.repeat(32), pubkey: peer, issuers: [host.pubkey] }),
    ).toEqual({ ok: false, reason: 'token expired' })
  })
})
