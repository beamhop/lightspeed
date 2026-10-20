import { describe, expect, test } from 'bun:test'
import { decodeCbor, encodeCbor } from './codec/cbor'
import { anonymous } from './identity/anonymous'
import { createSignalingHub, memorySignaling } from './signaling/memory'
import { unionSignaling } from './signaling/union'
import { compareHlc, HlcClock } from './state/hlc'
import { type StateOp, StateStore } from './state/store'
import type { Signal, SignalingFactory } from './types'
import { VirtualClock } from './util/clock'

describe('cbor', () => {
  test('round-trips the supported data model', () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      23,
      24,
      255,
      256,
      65535,
      65536,
      2 ** 32,
      Number.MAX_SAFE_INTEGER,
      -1,
      -25,
      -(2 ** 40),
      1.5,
      -0.25,
      Number.NaN,
      '',
      'héllo ✓',
      'x'.repeat(70_000),
      new Uint8Array([1, 2, 3]),
      new Uint8Array(70_000).fill(7),
      [1, [2, [3]], { a: 1 }],
      { nested: { deep: [null, 'v'] }, bytes: new Uint8Array([9]) },
    ]
    for (const v of values) expect(decodeCbor(encodeCbor(v))).toEqual(v)
    expect(decodeCbor(encodeCbor({ a: undefined, b: 1 }))).toEqual({ b: 1 })
  })

  test('known encodings (RFC 8949 appendix A)', () => {
    const hex = (v: unknown) => Buffer.from(encodeCbor(v)).toString('hex')
    expect(hex(0)).toBe('00')
    expect(hex(100)).toBe('1864')
    expect(hex(1000000)).toBe('1a000f4240')
    expect(hex(-100)).toBe('3863')
    expect(hex('IETF')).toBe('6449455446')
    expect(hex([1, [2, 3], [4, 5]])).toBe('8301820203820405')
    expect(hex({ a: 1 })).toBe('a1616101')
    expect(decodeCbor(Buffer.from('f93c00', 'hex'))).toBe(1) // float16
    expect(decodeCbor(Buffer.from('fa47c35000', 'hex'))).toBe(100000) // float32
  })

  test('rejects malformed input', () => {
    expect(() => decodeCbor(new Uint8Array([0x18]))).toThrow()
    expect(() => decodeCbor(new Uint8Array([0x00, 0x00]))).toThrow('trailing')
    expect(() => decodeCbor(new Uint8Array([0x9f]))).toThrow()
    expect(() => decodeCbor(new Uint8Array([0x9a, 0xff, 0xff, 0xff, 0xff]))).toThrow()
  })
})

describe('hlc + state', () => {
  test('hlc is monotonic and merges remote time', () => {
    let now = 1000
    const c = new HlcClock('a', () => now)
    const t1 = c.tick()
    const t2 = c.tick()
    expect(compareHlc(t1, t2)).toBe(-1)
    c.receive({ t: 5000, c: 3, n: 'b' })
    const t3 = c.tick()
    expect(t3.t).toBe(5000)
    expect(t3.c).toBe(5)
    now = 6000
    expect(c.tick()).toEqual({ t: 6000, c: 0, n: 'a' })
    // Far-future timestamps are ignored.
    c.receive({ t: now + 10 * 60_000, c: 0, n: 'evil' })
    expect(c.tick().t).toBe(6000)
  })

  test('LWW map and log converge regardless of delivery order', () => {
    const ops: StateOp[] = []
    const a = new StateStore(
      'aa',
      () => 100,
      (op) => ops.push(op),
    )
    const b = new StateStore(
      'bb',
      () => 100,
      (op) => ops.push(op),
    )
    a.map('m').set('k', 'from a')
    b.map('m').set('k', 'from b')
    a.map('m').set('x', 1)
    b.map('m').delete('x')
    a.log('l').append('a1')
    b.log('l').append('b1')
    a.log('l').append('a2')
    const c = new StateStore(
      'cc',
      () => 0,
      () => {},
    )
    const d = new StateStore(
      'dd',
      () => 0,
      () => {},
    )
    for (const op of ops) c.apply(op, true)
    for (const op of [...ops].reverse()) d.apply(op, true)
    for (const op of ops) d.apply(op, true) // duplicates are no-ops
    expect(c.digest()).toBe(d.digest())
    expect(c.map('m').get('k')).toBe('from b') // same ms+counter: node id tiebreak
    expect(c.log('l').values()).toEqual(d.log('l').values())
    expect(c.log('l').length).toBe(3)
    const e = new StateStore(
      'ee',
      () => 0,
      () => {},
    )
    e.merge(decodeCbor(encodeCbor(c.snapshot())) as ReturnType<StateStore['snapshot']>)
    expect(e.digest()).toBe(c.digest())
  })
})

describe('signaling', () => {
  test('union fans out and de-duplicates', async () => {
    const clock = new VirtualClock()
    const h1 = createSignalingHub({ clock })
    const h2 = createSignalingHub({ clock })
    const failing: SignalingFactory = () => ({
      announce: () => Promise.reject(new Error('down')),
      send: () => Promise.reject(new Error('down')),
      subscribe: () => () => {},
      close: async () => {},
    })
    const ia = await anonymous().load()
    const ib = await anonymous().load()
    const sa = unionSignaling(memorySignaling(h1), memorySignaling(h2), failing)({ identity: ia })
    const sb = unionSignaling([memorySignaling(h1), memorySignaling(h2)])({ identity: ib })
    const got: Signal[] = []
    sb.subscribe('t', (s) => got.push(s))
    sa.subscribe('t', () => {})
    await sa.announce('t', 'hello')
    await sa.send('t', ib.pubkey, 'direct')
    await clock.advance(10)
    expect(got.map((s) => [s.kind, s.content, s.from])).toEqual([
      ['announce', 'hello', ia.pubkey],
      ['direct', 'direct', ia.pubkey],
    ])
    expect(sb.status?.().length).toBe(2)
    const allFail = unionSignaling(failing)({ identity: ia })
    await expect(allFail.announce('t', 'x')).rejects.toThrow()
  })
})
