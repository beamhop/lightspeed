import type { Hex, TelemetryEvent, Unsubscribe } from './types'
import { Listeners } from './util/emitter'

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type TelemetryInput = DistributiveOmit<TelemetryEvent, 'at'>

/** In-process telemetry bus. Disabled buses drop events without allocating. */
export class TelemetryBus {
  private listeners = new Listeners<[TelemetryEvent]>()
  private remote = new Listeners<[Hex, TelemetryEvent]>()
  /** Ring buffer of recent events, for late subscribers (Studio attaching mid-session). */
  private history: TelemetryEvent[] = []

  constructor(
    public enabled: boolean,
    private now: () => number,
    private historySize = 500,
  ) {}

  emit(e: TelemetryInput): void {
    if (!this.enabled) return
    const ev = { ...e, at: this.now() } as TelemetryEvent
    if (this.historySize > 0) {
      this.history.push(ev)
      if (this.history.length > this.historySize) this.history.shift()
    }
    this.listeners.emit(ev)
  }

  /** Subscribe to local events. With `replay`, recent history is delivered first. */
  subscribe(cb: (e: TelemetryEvent) => void, opts: { replay?: boolean } = {}): Unsubscribe {
    if (opts.replay) for (const e of this.history) cb(e)
    return this.listeners.add(cb)
  }

  /** Events received from peers we observe over the reserved telemetry channel. */
  subscribeRemote(cb: (from: Hex, e: TelemetryEvent) => void): Unsubscribe {
    return this.remote.add(cb)
  }

  recent(): readonly TelemetryEvent[] {
    return this.history
  }

  /** @internal */
  emitRemote(from: Hex, e: TelemetryEvent): void {
    this.remote.emit(from, e)
  }

  get hasListeners(): boolean {
    return this.listeners.size > 0
  }
}
