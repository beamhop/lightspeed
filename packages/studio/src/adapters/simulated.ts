import type {
  ActiveFault,
  AdmissionResult,
  ConnectionInfo,
  Fault,
  Hex,
  IdentityKind,
  StudioEvent,
  StudioIdentity,
  StudioPeer,
  StudioRoom,
  Unsubscribe,
} from '../room-adapter'
import { SimEngine, type SimOptions } from '../sim/engine'

export interface SimulatedRoomOptions extends SimOptions {
  roomId?: string
  /** Wall-clock driving: tick interval in ms (default 100). */
  tickMs?: number
  /** Simulated ms per real ms (default 1). */
  speed?: number
  /** Run the simulation from this many ms before joining so there is history (default 0). */
  warmupMs?: number
  /** Admission policy the simulated room enforces for the observer identity. */
  admission?: 'open' | IdentityKind
  /** Drive the clock with setInterval after join (default true). Tests use advance() instead. */
  realtime?: boolean
}

/** A fully simulated room: N fake peers, signaling, path changes, messages, RTT and faults. */
export class SimulatedRoom implements StudioRoom {
  readonly mode = 'simulated' as const
  readonly roomId: string
  readonly capabilities = { faults: true, connectionInfo: true, identity: true }
  readonly engine: SimEngine
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly opts: SimulatedRoomOptions
  private identity: StudioIdentity | null = null

  constructor(opts: SimulatedRoomOptions = {}) {
    this.opts = opts
    this.roomId = opts.roomId ?? `sim-${opts.seed ?? 1}`
    this.engine = new SimEngine({ ...opts, start: opts.start ?? Date.now() - (opts.warmupMs ?? 0) })
    if (opts.warmupMs) this.engine.step(opts.warmupMs)
  }

  async join(): Promise<void> {
    if (this.timer || this.opts.realtime === false) return
    const tick = this.opts.tickMs ?? 100
    const speed = this.opts.speed ?? 1
    this.timer = setInterval(() => this.engine.step(tick * speed), tick)
  }

  async leave(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Advance simulated time manually (tests, paused mode). */
  advance(ms: number): StudioEvent[] {
    return this.engine.step(ms)
  }

  history(): readonly StudioEvent[] {
    return this.engine.events()
  }

  subscribe(cb: (event: StudioEvent) => void): Unsubscribe {
    return this.engine.subscribe(cb)
  }

  peers(): StudioPeer[] {
    const peers = this.engine.peers()
    if (this.identity) {
      peers.push({
        pubkey: this.identity.pubkey,
        name: `studio (${this.identity.label})`,
        isSelf: true,
        attestations: [this.identity.attestation.type],
      })
    }
    return peers
  }

  /** Spawn simulated peers (the in-browser counterpart of the headless peer spawner). */
  spawn(count = 1): Hex[] {
    const out: Hex[] = []
    for (let i = 0; i < count; i++) out.push(this.engine.addPeer())
    return out
  }

  async injectFault(fault: Fault): Promise<ActiveFault> {
    return this.engine.injectFault(fault)
  }

  async clearFault(id: string): Promise<void> {
    this.engine.clearFault(id)
  }

  faults(): readonly ActiveFault[] {
    return this.engine.faults()
  }

  connectionInfo(source: Hex, peer: Hex): ConnectionInfo | null {
    return this.engine.connectionInfo(source, peer)
  }

  async setIdentity(identity: StudioIdentity): Promise<AdmissionResult> {
    const policy = this.opts.admission ?? 'open'
    if (policy !== 'open' && identity.attestation.type !== policy) {
      return {
        admitted: false,
        reason: `room policy requires a ${policy} attestation, got ${identity.attestation.type}`,
      }
    }
    this.identity = identity
    return { admitted: true }
  }
}
