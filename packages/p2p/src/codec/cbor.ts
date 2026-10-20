// Small CBOR (RFC 8949) codec covering the data model the library sends: null/undefined, booleans,
// safe integers, float64, strings, byte strings, arrays and string-keyed maps. Deterministic output.

const enc = new TextEncoder()
const dec = new TextDecoder('utf-8', { fatal: true })

class Writer {
  buf = new Uint8Array(256)
  view = new DataView(this.buf.buffer)
  len = 0

  ensure(n: number): void {
    if (this.len + n <= this.buf.length) return
    let size = this.buf.length * 2
    while (size < this.len + n) size *= 2
    const next = new Uint8Array(size)
    next.set(this.buf.subarray(0, this.len))
    this.buf = next
    this.view = new DataView(next.buffer)
  }

  u8(v: number): void {
    this.ensure(1)
    this.buf[this.len++] = v
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length)
    this.buf.set(b, this.len)
    this.len += b.length
  }

  head(major: number, n: number): void {
    const m = major << 5
    if (n < 24) this.u8(m | n)
    else if (n < 0x100) {
      this.u8(m | 24)
      this.u8(n)
    } else if (n < 0x10000) {
      this.ensure(3)
      this.buf[this.len++] = m | 25
      this.view.setUint16(this.len, n)
      this.len += 2
    } else if (n < 0x100000000) {
      this.ensure(5)
      this.buf[this.len++] = m | 26
      this.view.setUint32(this.len, n)
      this.len += 4
    } else {
      this.ensure(9)
      this.buf[this.len++] = m | 27
      this.view.setUint32(this.len, Math.floor(n / 0x100000000))
      this.view.setUint32(this.len + 4, n >>> 0)
      this.len += 8
    }
  }

  value(v: unknown, depth: number): void {
    if (depth > 64) throw new RangeError('cbor: nesting too deep')
    if (v === null) return this.u8(0xf6)
    if (v === undefined) return this.u8(0xf7)
    if (v === false) return this.u8(0xf4)
    if (v === true) return this.u8(0xf5)
    if (typeof v === 'number') {
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) {
        if (v >= 0) this.head(0, v)
        else this.head(1, -1 - v)
      } else {
        this.ensure(9)
        this.buf[this.len++] = 0xfb
        this.view.setFloat64(this.len, v)
        this.len += 8
      }
      return
    }
    if (typeof v === 'bigint') return this.value(Number(v), depth)
    if (typeof v === 'string') {
      const b = enc.encode(v)
      this.head(3, b.length)
      return this.bytes(b)
    }
    if (v instanceof Uint8Array) {
      this.head(2, v.length)
      return this.bytes(v)
    }
    if (ArrayBuffer.isView(v)) {
      const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
      this.head(2, b.length)
      return this.bytes(b)
    }
    if (v instanceof ArrayBuffer) return this.value(new Uint8Array(v), depth)
    if (Array.isArray(v)) {
      this.head(4, v.length)
      for (const item of v) this.value(item, depth + 1)
      return
    }
    if (v instanceof Map) {
      this.head(5, v.size)
      for (const [k, item] of v) {
        this.value(k, depth + 1)
        this.value(item, depth + 1)
      }
      return
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      this.head(5, entries.length)
      for (const [k, item] of entries) {
        this.value(k, depth + 1)
        this.value(item, depth + 1)
      }
      return
    }
    throw new TypeError(`cbor: cannot encode ${typeof v}`)
  }
}

export function encodeCbor(value: unknown): Uint8Array {
  const w = new Writer()
  w.value(value, 0)
  return w.buf.slice(0, w.len)
}

class Reader {
  o = 0
  view: DataView
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  }

  need(n: number): void {
    if (this.o + n > this.buf.length) throw new RangeError('cbor: unexpected end of input')
  }

  arg(info: number): number {
    if (info < 24) return info
    if (info === 24) {
      this.need(1)
      return this.buf[this.o++] as number
    }
    if (info === 25) {
      this.need(2)
      const v = this.view.getUint16(this.o)
      this.o += 2
      return v
    }
    if (info === 26) {
      this.need(4)
      const v = this.view.getUint32(this.o)
      this.o += 4
      return v
    }
    if (info === 27) {
      this.need(8)
      const v = this.view.getUint32(this.o) * 0x100000000 + this.view.getUint32(this.o + 4)
      this.o += 8
      return v
    }
    throw new RangeError('cbor: indefinite lengths are not supported')
  }

  value(depth: number): unknown {
    if (depth > 64) throw new RangeError('cbor: nesting too deep')
    this.need(1)
    const ib = this.buf[this.o++] as number
    const major = ib >> 5
    const info = ib & 31
    switch (major) {
      case 0:
        return this.arg(info)
      case 1:
        return -1 - this.arg(info)
      case 2: {
        const n = this.arg(info)
        this.need(n)
        const out = this.buf.slice(this.o, this.o + n)
        this.o += n
        return out
      }
      case 3: {
        const n = this.arg(info)
        this.need(n)
        const s = dec.decode(this.buf.subarray(this.o, this.o + n))
        this.o += n
        return s
      }
      case 4: {
        const n = this.arg(info)
        if (n > this.buf.length - this.o) throw new RangeError('cbor: array length exceeds input')
        const arr: unknown[] = new Array(n)
        for (let i = 0; i < n; i++) arr[i] = this.value(depth + 1)
        return arr
      }
      case 5: {
        const n = this.arg(info)
        if (n > this.buf.length - this.o) throw new RangeError('cbor: map length exceeds input')
        const obj: Record<string, unknown> = Object.create(null)
        for (let i = 0; i < n; i++) {
          const k = this.value(depth + 1)
          const key = typeof k === 'string' ? k : String(k)
          obj[key] = this.value(depth + 1)
        }
        return { ...obj }
      }
      case 6:
        // Tags: decode and return the tagged value.
        this.arg(info)
        return this.value(depth + 1)
      default: {
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 23) return undefined
        if (info === 25) {
          this.need(2)
          const v = half(this.view.getUint16(this.o))
          this.o += 2
          return v
        }
        if (info === 26) {
          this.need(4)
          const v = this.view.getFloat32(this.o)
          this.o += 4
          return v
        }
        if (info === 27) {
          this.need(8)
          const v = this.view.getFloat64(this.o)
          this.o += 8
          return v
        }
        throw new RangeError(`cbor: unsupported simple value ${info}`)
      }
    }
  }
}

function half(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

export function decodeCbor(buf: Uint8Array): unknown {
  const r = new Reader(buf)
  const v = r.value(0)
  if (r.o !== buf.length) throw new RangeError('cbor: trailing bytes')
  return v
}
