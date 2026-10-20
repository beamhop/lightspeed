// Pure formatting helpers shared by every screen.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']

export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n < 0) return `-${formatBytes(-n, digits)}`
  if (n < 1024) return `${Math.round(n)} B`
  let i = 0
  let v = n
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : digits)} ${UNITS[i]}`
}

/** Bits per second, decimal units as network folks expect. */
export function formatBps(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return '—'
  const units = ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps']
  let i = 0
  let v = bps
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`
}

export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(digits)
}

/** Compact duration: 3d 4h, 5h 12m, 4m 2s, 12s. */
export function formatDuration(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const s = Math.floor(sec)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${r}s`
  return `${r}s`
}

/** Normalize a timestamp in seconds or milliseconds to milliseconds. */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts
}

export function formatAgo(ts: number | null | undefined, now = Date.now()): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const diff = Math.round((now - toMs(ts)) / 1000)
  if (diff < 0) return `in ${formatDuration(-diff)}`
  if (diff < 5) return 'just now'
  return `${formatDuration(diff)} ago`
}

export function formatDate(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const d = new Date(toMs(ts))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function shortHex(hex: string | null | undefined, head = 8, tail = 4): string {
  if (!hex) return '—'
  if (hex.length <= head + tail + 1) return hex
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`
}

export function formatSats(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${n.toLocaleString('en-US')} sats`
}

export function percent(used: number, total: number): number {
  if (!total || total <= 0) return 0
  return Math.max(0, Math.min(100, (used / total) * 100))
}

/** Parse "1, 3, 7" or "30000-30003" into kind numbers (dedup, sorted). Throws on garbage. */
export function parseKinds(input: string): number[] {
  const out = new Set<number>()
  for (const raw of input.split(/[\s,]+/)) {
    const part = raw.trim()
    if (!part) continue
    const range = /^(\d+)-(\d+)$/.exec(part)
    if (range) {
      const a = Number(range[1])
      const b = Number(range[2])
      if (b < a || b - a > 1000) throw new Error(`Bad kind range: ${part}`)
      for (let k = a; k <= b; k++) out.add(k)
    } else if (/^\d+$/.test(part)) {
      out.add(Number(part))
    } else throw new Error(`Not a kind number: ${part}`)
  }
  return [...out].sort((x, y) => x - y)
}

export function formatKinds(kinds: number[]): string {
  return kinds.join(', ')
}

// ---- bech32 (npub) ----
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const b = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= GEN[i] as number
  }
  return chk
}

function hrpExpand(hrp: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5)
  out.push(0)
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31)
  return out
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const out: number[] = []
  const max = (1 << to) - 1
  for (const v of data) {
    acc = (acc << from) | v
    bits += from
    while (bits >= to) {
      bits -= to
      out.push((acc >>> bits) & max)
    }
  }
  if (pad && bits > 0) out.push((acc << (to - bits)) & max)
  else if (!pad && (bits >= from || (acc << (to - bits)) & max))
    throw new Error('bech32: bad padding')
  return out
}

export function hexToBytes(hex: string): number[] {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2) throw new Error('Invalid hex')
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return out
}

export function bech32Encode(hrp: string, hex: string): string {
  const data = convertBits(hexToBytes(hex), 8, 5, true)
  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]
  const mod = polymod(values) ^ 1
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31)
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`
}

export function bech32Decode(str: string): { hrp: string; hex: string } {
  const s = str.toLowerCase()
  const pos = s.lastIndexOf('1')
  if (pos < 1 || pos + 7 > s.length) throw new Error('bech32: bad separator')
  const hrp = s.slice(0, pos)
  const values: number[] = []
  for (const c of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(c)
    if (v < 0) throw new Error('bech32: bad char')
    values.push(v)
  }
  if (polymod([...hrpExpand(hrp), ...values]) !== 1) throw new Error('bech32: bad checksum')
  const bytes = convertBits(values.slice(0, -6), 5, 8, false)
  return { hrp, hex: bytes.map((b) => b.toString(16).padStart(2, '0')).join('') }
}

export function npub(hex: string): string {
  try {
    return bech32Encode('npub', hex)
  } catch {
    return hex
  }
}

export function shortNpub(hex: string | null | undefined): string {
  if (!hex) return '—'
  return shortHex(npub(hex), 12, 6)
}

/** Accept a 64-char hex pubkey or an npub; returns hex or throws. */
export function parsePubkey(input: string): string {
  const v = input.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  if (v.startsWith('npub1')) {
    const { hrp, hex } = bech32Decode(v)
    if (hrp === 'npub' && hex.length === 64) return hex
  }
  throw new Error('Expected a 64-char hex pubkey or npub')
}

export function isIp(v: string): boolean {
  const s = v.trim()
  const cidr = s.split('/')
  const ip = cidr[0] ?? ''
  if (cidr.length > 2) return false
  if (cidr[1] !== undefined && !/^\d{1,3}$/.test(cidr[1])) return false
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return ip.split('.').every((o) => Number(o) <= 255)
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(':')
}

export function toCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const cols = Object.keys(rows[0] as object)
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n')
}
