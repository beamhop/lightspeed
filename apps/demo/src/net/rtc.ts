// Small WebRTC helpers shared by the demo's call code.

export type CandidatePath = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown'

/** Reads the selected candidate pair and reports the local candidate type. */
export async function selectedCandidateType(pc: RTCPeerConnection): Promise<{
  local: CandidatePath
  remote: CandidatePath
  rttMs?: number
}> {
  const stats = await pc.getStats()
  let pair: Record<string, unknown> | undefined
  const byId = new Map<string, Record<string, unknown>>()
  stats.forEach((s: Record<string, unknown>) => {
    byId.set(s.id as string, s)
  })
  for (const s of byId.values()) {
    if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
      pair = byId.get(s.selectedCandidatePairId)
    }
  }
  if (!pair) {
    for (const s of byId.values()) {
      if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) {
        pair = s
      }
    }
  }
  if (!pair) return { local: 'unknown', remote: 'unknown' }
  const local = byId.get(pair.localCandidateId as string)
  const remote = byId.get(pair.remoteCandidateId as string)
  const rtt = pair.currentRoundTripTime
  return {
    local: ((local?.candidateType as CandidatePath) ?? 'unknown') as CandidatePath,
    remote: ((remote?.candidateType as CandidatePath) ?? 'unknown') as CandidatePath,
    ...(typeof rtt === 'number' ? { rttMs: Math.round(rtt * 1000) } : {}),
  }
}

/** Human label for the plan's "direct vs. STUN path" readout. */
export function describeCandidatePath(local: CandidatePath, remote: CandidatePath): string {
  if (local === 'relay' || remote === 'relay') return 'TURN relay'
  if (local === 'host' && remote === 'host') return 'direct (LAN)'
  if (local === 'unknown') return 'negotiating…'
  return 'direct (STUN)'
}
