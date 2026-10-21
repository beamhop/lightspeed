import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { errorMessage } from '../store'
import { MascotMessage } from './Mascot'
import { Button } from './ui'

export interface Resource<T> {
  data: T | undefined
  error: unknown
  loading: boolean
  reload: () => Promise<void>
  /** Optimistically replace data (e.g. after a delete). */
  mutate: (fn: (d: T) => T) => void
}

/** Load async data with loading/error state; reloads when deps change; optional polling. */
export function useResource<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
  pollMs?: number,
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const loadRef = useRef(load)
  loadRef.current = load

  const reload = useCallback(async () => {
    const id = ++seq.current
    setLoading(true)
    try {
      const d = await loadRef.current()
      if (id !== seq.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (id !== seq.current) return
      setError(e)
    } finally {
      if (id === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
    if (!pollMs) return
    const t = setInterval(() => void reload(), pollMs)
    return () => clearInterval(t)
  }, deps)

  const mutate = useCallback((fn: (d: T) => T) => setData((d) => (d === undefined ? d : fn(d))), [])
  return { data, error, loading, reload, mutate }
}

/** Render a resource with mascot loading / error / empty states. */
export function Async<T>({
  res,
  empty,
  emptyTitle = 'Nothing here yet',
  children,
}: {
  res: Resource<T>
  empty?: (d: T) => boolean
  emptyTitle?: string
  children: (d: T) => ReactNode
}) {
  if (res.data === undefined && res.error) {
    return (
      <MascotMessage state="angry" title="Could not load this">
        <div className="mb-3">{errorMessage(res.error)}</div>
        <Button onClick={() => void res.reload()}>Try again</Button>
      </MascotMessage>
    )
  }
  if (res.data === undefined) return <MascotMessage state="spinner" title="Hopping over…" compact />
  const d = res.data
  const isEmpty = empty ? empty(d) : Array.isArray(d) && d.length === 0
  if (isEmpty) return <MascotMessage state="smile" title={emptyTitle} compact />
  return <>{children(d)}</>
}
