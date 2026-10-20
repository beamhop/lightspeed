// Replicated room state: LWW maps on hybrid logical clocks and append-only logs with per-author seqs.
// Ops and snapshots merge commutatively and idempotently, so replay order does not matter.
import type { Hex, Unsubscribe } from '../types'
import { Listeners } from '../util/emitter'
import { compareHlc, type Hlc, HlcClock, isHlc } from './hlc'

interface MapCell {
  v?: unknown
  /** Tombstone. */
  d?: boolean
  h: Hlc
}

export interface LogEntry<V = unknown> {
  /** Author pubkey. */
  a: Hex
  /** Per-author sequence number, starting at 1. */
  s: number
  h: Hlc
  v: V
}

export type StateOp =
  | { k: 'map'; n: string; key: string; v?: unknown; d?: boolean; h: Hlc }
  | { k: 'log'; n: string; e: LogEntry }

export interface StateSnapshot {
  maps: Record<string, [string, MapCell][]>
  logs: Record<string, LogEntry[]>
}

export interface MapChange<V> {
  key: string
  value: V | undefined
  deleted: boolean
  remote: boolean
}

export interface SharedMap<V = unknown> {
  readonly name: string
  get(key: string): V | undefined
  has(key: string): boolean
  set(key: string, value: V): void
  delete(key: string): void
  keys(): string[]
  entries(): [string, V][]
  toObject(): Record<string, V>
  readonly size: number
  subscribe(cb: (change: MapChange<V>) => void): Unsubscribe
}

export interface LogItem<V> {
  author: Hex
  seq: number
  at: number
  value: V
}

export interface SharedLog<V = unknown> {
  readonly name: string
  append(value: V): LogItem<V>
  /** Entries in HLC order (a total order identical on every peer). */
  entries(): LogItem<V>[]
  values(): V[]
  readonly length: number
  subscribe(cb: (item: LogItem<V>, remote: boolean) => void): Unsubscribe
}

export class StateStore {
  readonly clock: HlcClock
  private maps = new Map<string, Map<string, MapCell>>()
  private logs = new Map<
    string,
    { byKey: Map<string, LogEntry>; sorted: LogEntry[] | null; seq: number }
  >()
  private mapL = new Map<string, Listeners<[MapChange<unknown>]>>()
  private logL = new Map<string, Listeners<[LogItem<unknown>, boolean]>>()
  readonly changed = new Listeners<[string]>()

  constructor(
    readonly node: Hex,
    now: () => number,
    private broadcast: (op: StateOp) => void,
  ) {
    this.clock = new HlcClock(node, now)
  }

  private mapData(name: string): Map<string, MapCell> {
    let m = this.maps.get(name)
    if (!m) {
      m = new Map()
      this.maps.set(name, m)
    }
    return m
  }

  private logData(name: string) {
    let l = this.logs.get(name)
    if (!l) {
      l = { byKey: new Map(), sorted: null, seq: 0 }
      this.logs.set(name, l)
    }
    return l
  }

  private mapListeners(name: string) {
    let l = this.mapL.get(name)
    if (!l) {
      l = new Listeners()
      this.mapL.set(name, l)
    }
    return l
  }

  private logListeners(name: string) {
    let l = this.logL.get(name)
    if (!l) {
      l = new Listeners()
      this.logL.set(name, l)
    }
    return l
  }

  /** Apply an op (local or remote). Returns true when it changed visible state. */
  apply(op: StateOp, remote: boolean): boolean {
    if (op.k === 'map') {
      if (!isHlc(op.h) || typeof op.key !== 'string') return false
      if (remote) this.clock.receive(op.h)
      const m = this.mapData(op.n)
      const cur = m.get(op.key)
      if (cur && compareHlc(cur.h, op.h) >= 0) return false
      m.set(op.key, op.d ? { d: true, h: op.h } : { v: op.v, h: op.h })
      this.mapListeners(op.n).emit({
        key: op.key,
        value: op.d ? undefined : op.v,
        deleted: !!op.d,
        remote,
      })
      this.changed.emit(op.n)
      return true
    }
    if (op.k === 'log') {
      const e = op.e
      if (!e || !isHlc(e.h) || typeof e.a !== 'string' || typeof e.s !== 'number') return false
      if (remote) this.clock.receive(e.h)
      const l = this.logData(op.n)
      const key = `${e.a}:${e.s}`
      if (l.byKey.has(key)) return false
      l.byKey.set(key, e)
      l.sorted = null
      if (e.a === this.node) l.seq = Math.max(l.seq, e.s)
      this.logListeners(op.n).emit(toItem(e), remote)
      this.changed.emit(op.n)
      return true
    }
    return false
  }

  map<V>(name: string): SharedMap<V> {
    const store = this
    const data = () => this.mapData(name)
    const live = (): [string, MapCell][] => [...data()].filter(([, c]) => !c.d)
    return {
      name,
      get: (key) => {
        const c = data().get(key)
        return c && !c.d ? (c.v as V) : undefined
      },
      has: (key) => {
        const c = data().get(key)
        return !!c && !c.d
      },
      set(key, value) {
        const op: StateOp = { k: 'map', n: name, key, v: value, h: store.clock.tick() }
        store.apply(op, false)
        store.broadcast(op)
      },
      delete(key) {
        const op: StateOp = { k: 'map', n: name, key, d: true, h: store.clock.tick() }
        store.apply(op, false)
        store.broadcast(op)
      },
      keys: () => live().map(([k]) => k),
      entries: () => live().map(([k, c]) => [k, c.v as V]),
      toObject: () => Object.fromEntries(live().map(([k, c]) => [k, c.v as V])),
      get size() {
        return live().length
      },
      subscribe: (cb) => this.mapListeners(name).add(cb as (c: MapChange<unknown>) => void),
    }
  }

  log<V>(name: string): SharedLog<V> {
    const store = this
    const sorted = (): LogEntry[] => {
      const l = this.logData(name)
      if (!l.sorted) l.sorted = [...l.byKey.values()].sort((a, b) => compareHlc(a.h, b.h))
      return l.sorted
    }
    return {
      name,
      append(value) {
        const l = store.logData(name)
        const e: LogEntry = { a: store.node, s: l.seq + 1, h: store.clock.tick(), v: value }
        const op: StateOp = { k: 'log', n: name, e }
        store.apply(op, false)
        store.broadcast(op)
        return toItem(e) as LogItem<V>
      },
      entries: () => sorted().map((e) => toItem(e) as LogItem<V>),
      values: () => sorted().map((e) => e.v as V),
      get length() {
        return store.logData(name).byKey.size
      },
      subscribe: (cb) =>
        this.logListeners(name).add(cb as (i: LogItem<unknown>, r: boolean) => void),
    }
  }

  snapshot(): StateSnapshot {
    const maps: StateSnapshot['maps'] = {}
    for (const [n, m] of this.maps) maps[n] = [...m]
    const logs: StateSnapshot['logs'] = {}
    for (const [n, l] of this.logs) logs[n] = [...l.byKey.values()]
    return { maps, logs }
  }

  /** Merge a snapshot; returns the number of ops that changed state. */
  merge(snap: StateSnapshot): number {
    let n = 0
    for (const [name, cells] of Object.entries(snap.maps ?? {})) {
      for (const [key, c] of cells ?? []) {
        if (this.apply({ k: 'map', n: name, key, v: c.v, d: c.d, h: c.h }, true)) n++
      }
    }
    for (const [name, entries] of Object.entries(snap.logs ?? {})) {
      for (const e of entries ?? []) if (this.apply({ k: 'log', n: name, e }, true)) n++
    }
    return n
  }

  /** Canonical content string, equal on converged peers (tests, Studio). */
  digest(): string {
    const maps = [...this.maps.keys()].sort().map((n) => {
      const m = this.mapData(n)
      return [n, [...m.keys()].sort().map((k) => [k, m.get(k)])]
    })
    const logs = [...this.logs.keys()].sort().map((n) => [n, this.log(n).entries()])
    return JSON.stringify({ maps, logs })
  }
}

function toItem<V>(e: LogEntry): LogItem<V> {
  return { author: e.a, seq: e.s, at: e.h.t, value: e.v as V }
}
