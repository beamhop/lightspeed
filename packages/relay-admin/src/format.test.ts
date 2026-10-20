import { describe, expect, test } from 'bun:test'
import {
  bech32Decode,
  formatAgo,
  formatBps,
  formatBytes,
  formatDuration,
  formatNumber,
  formatSats,
  isIp,
  npub,
  parseKinds,
  parsePubkey,
  percent,
  shortHex,
  toCsv,
  toMs,
} from './format'

describe('formatters', () => {
  test('bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MB')
    expect(formatBytes(undefined)).toBe('—')
    expect(formatBytes(-2048)).toBe('-2.0 KB')
  })
  test('bps uses decimal units', () => {
    expect(formatBps(950)).toBe('950 bps')
    expect(formatBps(38_400_000)).toBe('38.4 Mbps')
    expect(formatBps(1.2e9)).toBe('1.2 Gbps')
    expect(formatBps(Number.NaN)).toBe('—')
  })
  test('numbers', () => {
    expect(formatNumber(999)).toBe('999')
    expect(formatNumber(12_345)).toBe('12.3k')
    expect(formatNumber(1_284_310)).toBe('1.3M')
    expect(formatSats(50000)).toBe('50,000 sats')
  })
  test('durations and relative time', () => {
    expect(formatDuration(12)).toBe('12s')
    expect(formatDuration(62)).toBe('1m 2s')
    expect(formatDuration(3 * 3600 + 120)).toBe('3h 2m')
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3d 4h')
    const now = 1_700_000_000_000
    expect(toMs(1_700_000_000)).toBe(now)
    expect(formatAgo(1_700_000_000 - 90, now)).toBe('1m 30s ago')
    expect(formatAgo(now - 1000, now)).toBe('just now')
    expect(formatAgo(1_700_000_000 + 3600, now)).toBe('in 1h 0m')
  })
  test('shortHex, percent', () => {
    expect(shortHex('a'.repeat(64))).toBe('aaaaaaaa…aaaa')
    expect(shortHex('abc')).toBe('abc')
    expect(percent(50, 200)).toBe(25)
    expect(percent(5, 0)).toBe(0)
    expect(percent(500, 100)).toBe(100)
  })
})

describe('parsers', () => {
  test('kinds with ranges', () => {
    expect(parseKinds('1, 7,3')).toEqual([1, 3, 7])
    expect(parseKinds('30000-30002 1')).toEqual([1, 30000, 30001, 30002])
    expect(parseKinds('')).toEqual([])
    expect(() => parseKinds('abc')).toThrow()
    expect(() => parseKinds('10-5')).toThrow()
  })
  test('npub roundtrip (NIP-19 vector)', () => {
    const hex = '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d'
    const n = 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6'
    expect(npub(hex)).toBe(n)
    expect(bech32Decode(n)).toEqual({ hrp: 'npub', hex })
    expect(parsePubkey(n)).toBe(hex)
    expect(parsePubkey(hex.toUpperCase())).toBe(hex)
    expect(() => parsePubkey('npub1invalid')).toThrow()
    expect(() => parsePubkey('xyz')).toThrow()
  })
  test('ip validation', () => {
    expect(isIp('203.0.113.7')).toBe(true)
    expect(isIp('203.0.113.0/24')).toBe(true)
    expect(isIp('2001:db8::1')).toBe(true)
    expect(isIp('256.1.1.1')).toBe(false)
    expect(isIp('hello')).toBe(false)
  })
  test('csv escaping', () => {
    expect(
      toCsv([
        { a: 1, b: 'x,y' },
        { a: 2, b: 'say "hi"' },
      ]),
    ).toBe('a,b\n1,"x,y"\n2,"say ""hi"""')
    expect(toCsv([])).toBe('')
  })
})
