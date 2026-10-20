// RFC 4571-style stream framing for STUN/TURN over TCP and TLS (RFC 8656 §12.5): the stream is a
// sequence of STUN messages and ChannelData messages; ChannelData is padded to a multiple of 4.
import { HEADER_SIZE, pad4 } from './stun'

/** Upper bound for a single frame; STUN length is 16 bits so 65535 + 20 is the real max. */
const MAX_FRAME = 0xffff + HEADER_SIZE

export class StreamFramer {
  private buf: Uint8Array = new Uint8Array(0)
  /** Set once a byte sequence that cannot start a frame is seen; the stream must be closed. */
  broken = false

  /** Feed bytes; returns every complete frame (each a standalone copy-free view when possible). */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.broken) return []
    let data: Uint8Array
    if (this.buf.length === 0) data = chunk
    else {
      data = new Uint8Array(this.buf.length + chunk.length)
      data.set(this.buf)
      data.set(chunk, this.buf.length)
    }
    const frames: Uint8Array[] = []
    let off = 0
    while (data.length - off >= 4) {
      const b0 = data[off] as number
      const len = ((data[off + 2] as number) << 8) | (data[off + 3] as number)
      let total: number
      if (b0 < 0x40) total = HEADER_SIZE + len
      else if (b0 < 0x80) total = 4 + pad4(len)
      else {
        this.broken = true
        return frames
      }
      if (total > MAX_FRAME) {
        this.broken = true
        return frames
      }
      if (data.length - off < total) break
      frames.push(data.subarray(off, off + total))
      off += total
    }
    // Keep the remainder; copy so we do not pin a large chunk.
    this.buf = off === data.length ? new Uint8Array(0) : data.slice(off)
    return frames
  }
}

/** True when the first bytes of a (decrypted) stream are a STUN message rather than e.g. HTTP. */
export function looksLikeStunStream(first: Uint8Array): boolean {
  if (first.length < 8) return false
  return (
    (first[0] as number) < 0x40 &&
    first[4] === 0x21 &&
    first[5] === 0x12 &&
    first[6] === 0xa4 &&
    first[7] === 0x42
  )
}
