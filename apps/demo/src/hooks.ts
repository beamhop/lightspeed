import { useEffect, useState } from 'react'
import type { DemoPeer, DemoRoom, Hex, TelemetrySnapshot } from './p2p'

export function usePeers(room: DemoRoom): DemoPeer[] {
  const [peers, setPeers] = useState(() => room.peers())
  useEffect(() => {
    setPeers(room.peers())
    return room.onPeers(setPeers)
  }, [room])
  return peers
}

export function useCallPeers(room: DemoRoom): Hex[] {
  const [ids, setIds] = useState(() => room.callPeers())
  useEffect(() => {
    setIds(room.callPeers())
    return room.onCallPeers(setIds)
  }, [room])
  return ids
}

export function useTelemetry(room: DemoRoom): TelemetrySnapshot {
  const [t, setT] = useState(() => room.telemetry())
  useEffect(() => room.onTelemetry(setT), [room])
  return t
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

export function shortId(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-4)}`
}

const STORE_KEY = 'beamhop-demo'

export function loadStored<T extends object>(): Partial<T> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<T>
  } catch {
    return {}
  }
}

export function saveStored<T extends object>(patch: Partial<T>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ ...loadStored<T>(), ...patch }))
  } catch {
    // Private mode or storage disabled: settings just don't persist.
  }
}
