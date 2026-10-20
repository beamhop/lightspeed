// TypeScript port of the reference Negentropy v1 implementation (hoytech/negentropy, MIT),
// used for NIP-77 set reconciliation. Messages are hex strings on the wire.
import { sha256 } from '@noble/hashes/sha2'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils'

export const PROTOCOL_VERSION = 0x61
const ID_SIZE = 32
const FINGERPRINT_SIZE = 16
const MAX_TS = Number.MAX_VALUE

const Mode = { Skip: 0, Fingerprint: 1, IdList: 2 } as const

export interface NegItem {
  timestamp: number
  id: Uint8Array
}

class ByteWriter {
  private buf: Uint8Array
  length = 0
  constructor(initial = 256) {
    this.buf = new Uint8Array(initial)
  }
  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return
    let cap = this.buf.length * 2
    while (cap < this.length + n) cap *= 2
    const next = new Uint8Array(cap)
    next.set(this.buf.subarray(0, this.length))
    this.buf = next
  }
  push(b: number) {
    this.ensure(1)
    this.buf[this.length++] = b
  }
  extend(bytes: Uint8Array | ByteWriter) {
    const src = bytes instanceof ByteWriter ? bytes.unwrap() : bytes
    this.ensure(src.length)
    this.buf.set(src, this.length)
    this.length += src.length
  }
  unwrap() {
    return this.buf.subarray(0, this.length)
  }
}

class ByteReader {
  private pos = 0
  constructor(private buf: Uint8Array) {}
  get remaining() {
    return this.buf.length - this.pos
  }
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error('parse ends prematurely')
    return this.buf[this.pos++] as number
  }
  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('parse ends prematurely')
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }
}

function decodeVarInt(r: ByteReader): number {
  let res = 0
  for (;;) {
    const byte = r.byte()
    res = res * 128 + (byte & 127)
    if ((byte & 128) === 0) break
  }
  return res
}

function encodeVarInt(n: number): Uint8Array {
  if (n === 0) return new Uint8Array([0])
  const o: number[] = []
  while (n !== 0) {
    o.push(n % 128)
    n = Math.floor(n / 128)
  }
  o.reverse()
  for (let i = 0; i < o.length - 1; i++) o[i] = (o[i] as number) | 128
  return new Uint8Array(o)
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

function itemCompare(a: NegItem, b: NegItem): number {
  if (a.timestamp === b.timestamp) return compareBytes(a.id, b.id)
  return a.timestamp < b.timestamp ? -1 : 1
}

/** 256-bit little-endian modular sum of ids. */
class Accumulator {
  buf = new Uint8Array(ID_SIZE)
  add(other: Uint8Array) {
    let carry = 0
    for (let i = 0; i < ID_SIZE; i++) {
      const s = (this.buf[i] as number) + (other[i] as number) + carry
      this.buf[i] = s & 0xff
      carry = s >> 8
    }
  }
  fingerprint(n: number): Uint8Array {
    const input = new Uint8Array(ID_SIZE + 10)
    input.set(this.buf, 0)
    const v = encodeVarInt(n)
    input.set(v, ID_SIZE)
    return sha256(input.subarray(0, ID_SIZE + v.length)).subarray(0, FINGERPRINT_SIZE)
  }
}

/** Sorted (timestamp, id) vector — the relay's id/time index for one reconciliation. */
export class NegentropyStorageVector {
  private items: NegItem[] = []
  private sealed = false

  insert(timestamp: number, id: string | Uint8Array) {
    if (this.sealed) throw new Error('already sealed')
    const bytes = typeof id === 'string' ? hexToBytes(id) : id
    if (bytes.length !== ID_SIZE) throw new Error('bad id size for added item')
    this.items.push({ timestamp, id: bytes })
  }

  seal() {
    if (this.sealed) throw new Error('already sealed')
    this.sealed = true
    this.items.sort(itemCompare)
    for (let i = 1; i < this.items.length; i++) {
      if (itemCompare(this.items[i - 1] as NegItem, this.items[i] as NegItem) === 0)
        throw new Error('duplicate item inserted')
    }
  }

  size() {
    this.checkSealed()
    return this.items.length
  }

  getItem(i: number): NegItem {
    this.checkSealed()
    const it = this.items[i]
    if (!it) throw new Error('index out of range')
    return it
  }

  iterate(begin: number, end: number, cb: (item: NegItem, i: number) => boolean) {
    this.checkSealed()
    this.checkBounds(begin, end)
    for (let i = begin; i < end; i++) if (!cb(this.items[i] as NegItem, i)) break
  }

  findLowerBound(begin: number, end: number, bound: NegItem): number {
    this.checkSealed()
    this.checkBounds(begin, end)
    let lo = begin
    let hi = end
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (itemCompare(this.items[mid] as NegItem, bound) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  fingerprint(begin: number, end: number): Uint8Array {
    const acc = new Accumulator()
    this.iterate(begin, end, (item) => {
      acc.add(item.id)
      return true
    })
    return acc.fingerprint(end - begin)
  }

  private checkSealed() {
    if (!this.sealed) throw new Error('not sealed')
  }
  private checkBounds(begin: number, end: number) {
    if (begin > end || end > this.items.length) throw new Error('bad range')
  }
}

export class Negentropy {
  private lastTimestampIn = 0
  private lastTimestampOut = 0
  private isInitiator = false

  constructor(
    private storage: NegentropyStorageVector,
    private frameSizeLimit = 0,
  ) {
    if (frameSizeLimit !== 0 && frameSizeLimit < 4096) throw new Error('frameSizeLimit too small')
  }

  private bound(timestamp: number, id?: Uint8Array): NegItem {
    return { timestamp, id: id ?? new Uint8Array(0) }
  }

  /** Client side: produce the initial message (hex). */
  initiate(): string {
    if (this.isInitiator) throw new Error('already initiated')
    this.isInitiator = true
    const out = new ByteWriter()
    out.push(PROTOCOL_VERSION)
    this.splitRange(0, this.storage.size(), this.bound(MAX_TS), out)
    return bytesToHex(out.unwrap())
  }

  setInitiator() {
    this.isInitiator = true
  }

  /**
   * Process a message. Returns the reply (hex; null when the initiator is done) plus, for the
   * initiator, ids it has that the other side lacks (`have`) and ids it lacks (`need`).
   */
  reconcile(queryHex: string): [string | null, string[], string[]] {
    const have: string[] = []
    const need: string[] = []
    const query = new ByteReader(hexToBytes(queryHex))
    this.lastTimestampIn = 0
    this.lastTimestampOut = 0
    const full = new ByteWriter()
    full.push(PROTOCOL_VERSION)

    const version = query.byte()
    if (version < 0x60 || version > 0x6f)
      throw new Error('invalid negentropy protocol version byte')
    if (version !== PROTOCOL_VERSION) {
      if (this.isInitiator)
        throw new Error(`unsupported negentropy protocol version requested: ${version - 0x60}`)
      return [bytesToHex(full.unwrap()), have, need]
    }

    const storageSize = this.storage.size()
    let prevBound = this.bound(0)
    let prevIndex = 0
    let skip = false

    while (query.remaining !== 0) {
      let o = new ByteWriter()
      const doSkip = () => {
        if (skip) {
          skip = false
          o.extend(this.encodeBound(prevBound))
          o.extend(encodeVarInt(Mode.Skip))
        }
      }

      const currBound = this.decodeBound(query)
      const mode = decodeVarInt(query)
      const lower = prevIndex
      let upper = this.storage.findLowerBound(prevIndex, storageSize, currBound)

      if (mode === Mode.Skip) {
        skip = true
      } else if (mode === Mode.Fingerprint) {
        const theirs = query.bytes(FINGERPRINT_SIZE)
        const ours = this.storage.fingerprint(lower, upper)
        if (compareBytes(theirs, ours) !== 0) {
          doSkip()
          this.splitRange(lower, upper, currBound, o)
        } else {
          skip = true
        }
      } else if (mode === Mode.IdList) {
        const numIds = decodeVarInt(query)
        const theirElems = new Map<string, true>()
        for (let i = 0; i < numIds; i++) {
          const e = query.bytes(ID_SIZE)
          if (this.isInitiator) theirElems.set(bytesToHex(e), true)
        }
        if (this.isInitiator) {
          skip = true
          this.storage.iterate(lower, upper, (item) => {
            const k = bytesToHex(item.id)
            if (!theirElems.has(k)) have.push(k)
            else theirElems.delete(k)
            return true
          })
          for (const k of theirElems.keys()) need.push(k)
        } else {
          doSkip()
          const responseIds = new ByteWriter()
          let numResponseIds = 0
          let endBound = currBound
          this.storage.iterate(lower, upper, (item, index) => {
            if (this.exceededFrameSizeLimit(full.length + responseIds.length)) {
              endBound = item
              upper = index
              return false
            }
            responseIds.extend(item.id)
            numResponseIds++
            return true
          })
          o.extend(this.encodeBound(endBound))
          o.extend(encodeVarInt(Mode.IdList))
          o.extend(encodeVarInt(numResponseIds))
          o.extend(responseIds)
          full.extend(o)
          o = new ByteWriter()
        }
      } else {
        throw new Error('unexpected mode')
      }

      if (this.exceededFrameSizeLimit(full.length + o.length)) {
        const remaining = this.storage.fingerprint(upper, storageSize)
        full.extend(this.encodeBound(this.bound(MAX_TS)))
        full.extend(encodeVarInt(Mode.Fingerprint))
        full.extend(remaining)
        break
      }
      full.extend(o)
      prevIndex = upper
      prevBound = currBound
    }

    const done = full.length === 1 && this.isInitiator
    return [done ? null : bytesToHex(full.unwrap()), have, need]
  }

  private splitRange(lower: number, upper: number, upperBound: NegItem, o: ByteWriter) {
    const numElems = upper - lower
    const buckets = 16
    if (numElems < buckets * 2) {
      o.extend(this.encodeBound(upperBound))
      o.extend(encodeVarInt(Mode.IdList))
      o.extend(encodeVarInt(numElems))
      this.storage.iterate(lower, upper, (item) => {
        o.extend(item.id)
        return true
      })
      return
    }
    const itemsPerBucket = Math.floor(numElems / buckets)
    const bucketsWithExtra = numElems % buckets
    let curr = lower
    for (let i = 0; i < buckets; i++) {
      const bucketSize = itemsPerBucket + (i < bucketsWithExtra ? 1 : 0)
      const fp = this.storage.fingerprint(curr, curr + bucketSize)
      curr += bucketSize
      let nextBound: NegItem
      if (curr === upper) {
        nextBound = upperBound
      } else {
        const prev = this.storage.getItem(curr - 1)
        const next = this.storage.getItem(curr)
        nextBound = this.minimalBound(prev, next)
      }
      o.extend(this.encodeBound(nextBound))
      o.extend(encodeVarInt(Mode.Fingerprint))
      o.extend(fp)
    }
  }

  private exceededFrameSizeLimit(n: number) {
    return this.frameSizeLimit !== 0 && n > this.frameSizeLimit - 200
  }

  private decodeTimestampIn(r: ByteReader): number {
    let ts = decodeVarInt(r)
    ts = ts === 0 ? MAX_TS : ts - 1
    if (this.lastTimestampIn === MAX_TS || ts === MAX_TS) {
      this.lastTimestampIn = MAX_TS
      return MAX_TS
    }
    ts += this.lastTimestampIn
    this.lastTimestampIn = ts
    return ts
  }

  private decodeBound(r: ByteReader): NegItem {
    const timestamp = this.decodeTimestampIn(r)
    const len = decodeVarInt(r)
    if (len > ID_SIZE) throw new Error('bound key too long')
    return { timestamp, id: r.bytes(len) }
  }

  private encodeTimestampOut(ts: number): Uint8Array {
    if (ts === MAX_TS) {
      this.lastTimestampOut = MAX_TS
      return encodeVarInt(0)
    }
    const temp = ts
    ts -= this.lastTimestampOut
    this.lastTimestampOut = temp
    return encodeVarInt(ts + 1)
  }

  private encodeBound(b: NegItem): ByteWriter {
    const out = new ByteWriter(48)
    out.extend(this.encodeTimestampOut(b.timestamp))
    out.extend(encodeVarInt(b.id.length))
    out.extend(b.id)
    return out
  }

  private minimalBound(prev: NegItem, curr: NegItem): NegItem {
    if (curr.timestamp !== prev.timestamp) return this.bound(curr.timestamp)
    let shared = 0
    for (let i = 0; i < ID_SIZE; i++) {
      if (curr.id[i] !== prev.id[i]) break
      shared++
    }
    return this.bound(curr.timestamp, curr.id.subarray(0, shared + 1))
  }
}
