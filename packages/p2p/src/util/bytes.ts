import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils'

export { bytesToHex, hexToBytes, utf8ToBytes }

const decoder = new TextDecoder()
export const bytesToUtf8 = (b: Uint8Array): string => decoder.decode(b)

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  crypto.getRandomValues(out)
  return out
}

export function randomId(bytes = 8): string {
  return bytesToHex(randomBytes(bytes))
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= (a[i] as number) ^ (b[i] as number)
  return d === 0
}

export function toBase64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64UrlEncode(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function base64UrlDecode(s: string): Uint8Array {
  const t = s.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(t + '='.repeat((4 - (t.length % 4)) % 4))
}

export function isHex32(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)
}

export function compareHex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
