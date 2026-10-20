import { describe, expect, test } from 'bun:test'
import { createApi, normalizePolicy } from './api'
import { signInWithSigner, validTotp } from './auth'
import { diffPolicy, retentionLabel } from './components/PolicyEditor'
import { createMockApi } from './mock/server'
import { KIND_ADMIN_AUTH, localSigner, verifyEvent } from './nostr'
import { diffSettings } from './screens/Settings'
import type { NostrEvent } from './types'

describe('sign-in', () => {
  test('nostr challenge flow signs a kind 27235 event and opens a session', async () => {
    const mock = createMockApi()
    let sent: NostrEvent | null = null
    const spy = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/auth/nostr')) sent = JSON.parse(String(init?.body)).event
      return mock.fetch(input, init)
    }) as typeof fetch
    const api = createApi({ fetch: spy })
    const signer = localSigner()
    const me = await signInWithSigner(api, signer, 'https://relay.example')
    expect(me.pubkey).toBe(await signer.getPublicKey())
    expect(sent).not.toBeNull()
    const ev = sent as unknown as NostrEvent
    expect(ev.kind).toBe(KIND_ADMIN_AUTH)
    expect(ev.tags).toContainEqual(['u', 'https://relay.example/api/admin/auth/nostr'])
    expect(ev.tags.find((t) => t[0] === 'challenge')?.[1]).toHaveLength(32)
    expect(verifyEvent(ev)).toBe(true)
    expect(mock.db.loggedIn).toBe(true)
  })

  test('bootstrap with password returns a TOTP uri', async () => {
    const mock = createMockApi()
    const api = createApi({ fetch: mock.fetch })
    const res = await api.auth.bootstrap({
      token: 'tok',
      username: 'owner',
      password: 'correct horse battery',
    })
    expect(res.role).toBe('owner')
    expect(res.totpUri?.startsWith('otpauth://totp/')).toBe(true)
    await expect(
      api.auth.bootstrap({ token: 'used', username: 'x', password: 'y' }),
    ).rejects.toMatchObject({ status: 409 })
  })

  test('validTotp', () => {
    expect(validTotp('123456')).toBe(true)
    expect(validTotp(' 123456 ')).toBe(true)
    expect(validTotp('12345')).toBe(false)
    expect(validTotp('abcdef')).toBe(false)
  })
})

describe('confirmation scope builders', () => {
  test('diffPolicy spells out each change', () => {
    const a = normalizePolicy({})
    const pk = 'ab'.repeat(32)
    const b = normalizePolicy({
      pubkeys: { allow: [], deny: [pk] },
      kinds: { allow: [], deny: [4] },
      minPow: 16,
      rateLimits: {
        perIp: { events: 100, windowSec: 60 },
        perPubkey: { events: 0, windowSec: 60 },
      },
      retention: [{ kinds: [1], maxAgeSec: 86400 * 30 }],
    })
    const d = diffPolicy(a, b)
    expect(d.some((l) => l.startsWith('Denied pubkeys: add npub1'))).toBe(true)
    expect(d).toContain('Denied kinds: add 4')
    expect(d).toContain('NIP-13 min PoW: 0 → 16 bits')
    expect(d).toContain('Per-IP rate limit: unlimited → 100/60s')
    expect(d.find((l) => l.startsWith('Retention'))).toContain('kinds 1: max age 30d 0h')
    expect(diffPolicy(a, a)).toEqual([])
    expect(diffPolicy(b, a)).toContain('Denied kinds: remove 4')
  })

  test('retentionLabel', () => {
    expect(retentionLabel({ kinds: [1, 7], maxCount: 100 })).toBe('kinds 1, 7: keep 100/pubkey')
    expect(retentionLabel({ kinds: [3] })).toBe('kinds 3: forever')
  })

  test('diffSettings walks nested objects', () => {
    const mock = createMockApi()
    const a = mock.db.settings
    const b = {
      ...a,
      logging: { ...a.logging, level: 'debug' as const },
      listeners: { ...a.listeners, relayPorts: [50000, 60000] as [number, number] },
    }
    expect(diffSettings(a, b)).toEqual([
      'listeners.relayPorts: [49152,65535] → [50000,60000]',
      'logging.level: "info" → "debug"',
    ])
  })
})
