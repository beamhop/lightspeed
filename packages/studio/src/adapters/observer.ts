// Observer peer: Studio joins the room as a real peer with a `debug` capability token and
// receives every peer's telemetry on the reserved `__beamhop/telemetry` channel.
//
// TODO(@beamhop/p2p): wire this to the real Room once `createRoom` lands. Sketch:
//
//   const room = createRoom({
//     appId, roomId, password,
//     identity,                          // from the identity switcher
//     signaling: nostrSignaling({ relays }),
//     transports: [relayTransport({ url: relay })],   // no WebRTC needed for an observer
//     capability: { token: debugToken }, // caps: ['join', 'debug']; any token when app dev: true
//     observer: true,                    // don't count towards presence / mesh limits
//   })
//   room.channel(TELEMETRY_CHANNEL).onMessage((from, frame) => push(from, decode(frame)))
//   room.onPeerJoin / onPeerLeave       → peers()
//   injectFault → room.channel(TELEMETRY_CHANNEL).send(target, { type: 'fault', fault })
//                 (handled by each peer's dev hook on live WebRTC channels)
//   connectionInfo → request/response on the same channel
//   setIdentity → leave + re-join with the new identity; admission error → AdmissionResult
//
// Until then the adapter reports itself as unavailable so the UI can explain why.
import type {
  ActiveFault,
  AdmissionResult,
  ConnectionInfo,
  Fault,
  StudioEvent,
  StudioIdentity,
  StudioPeer,
  StudioRoom,
  Unsubscribe,
} from '../room-adapter'
import { UnsupportedError } from '../room-adapter'

export interface ObserverRoomOptions {
  appId: string
  roomId: string
  relay: string
  password?: string
  /** Capability token with the `debug` cap (signed by the app key). */
  debugToken?: string
}

export const OBSERVER_UNAVAILABLE =
  'Observer mode needs @beamhop/p2p createRoom with a debug capability; it is not wired yet. Use the in-page bridge or the simulated room.'

export class ObserverRoom implements StudioRoom {
  readonly mode = 'observer' as const
  readonly roomId: string
  readonly capabilities = { faults: false, connectionInfo: false, identity: false }
  readonly options: ObserverRoomOptions
  static readonly available = false

  constructor(options: ObserverRoomOptions) {
    this.options = options
    this.roomId = options.roomId
  }

  async join(): Promise<void> {
    throw new Error(OBSERVER_UNAVAILABLE)
  }

  async leave(): Promise<void> {}

  history(): readonly StudioEvent[] {
    return []
  }

  subscribe(_cb: (event: StudioEvent) => void): Unsubscribe {
    return () => {}
  }

  peers(): StudioPeer[] {
    return []
  }

  async injectFault(_fault: Fault): Promise<ActiveFault> {
    throw new UnsupportedError('Fault injection', this.mode)
  }

  async clearFault(_id: string): Promise<void> {}

  faults(): readonly ActiveFault[] {
    return []
  }

  connectionInfo(): ConnectionInfo | null {
    return null
  }

  async setIdentity(_identity: StudioIdentity): Promise<AdmissionResult> {
    return { admitted: false, reason: OBSERVER_UNAVAILABLE }
  }
}
