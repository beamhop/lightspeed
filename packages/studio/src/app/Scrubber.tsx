/** @jsxImportSource preact */
import { Button, IconButton } from '@beamhop/ui'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { histogram } from '../model/timeline'
import { clock, offset } from './format'
import { cursor, events, goLive, live, range, scrubTo, viewTime } from './store'

const BUCKETS = 120

/** Global replay control: drag to pin every view to a past instant; Live follows the tail. */
export function Scrubber() {
  const r = range.value
  const [playing, setPlaying] = useState(false)
  const raf = useRef<number | null>(null)
  const start = r?.start ?? 0
  const end = r?.end ?? 0
  const t = viewTime.value

  // density strip behind the slider (cheap: recomputed when the event count changes)
  const len = events.value.length
  const density = useMemo(
    () => (r ? histogram(events.value, start, end, BUCKETS) : []),
    [len, start, end],
  )
  const peak = Math.max(1, ...density)

  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const step = (now: number) => {
      const dt = now - last
      last = now
      const next = cursor.value + dt
      if (next >= (range.value?.end ?? 0)) {
        setPlaying(false)
        goLive()
        return
      }
      scrubTo(next)
      raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current)
    }
  }, [playing])

  if (!r) return <footer class="scrubber scrubber--empty bh-muted">Waiting for telemetry…</footer>

  return (
    <footer class="scrubber">
      <IconButton
        size="sm"
        label={playing ? 'Pause replay' : 'Play from cursor'}
        icon={playing ? '❚❚' : '▶'}
        onClick={() => {
          if (live.value) scrubTo(Math.max(start, end - 15_000))
          setPlaying(!playing)
        }}
      />
      <IconButton
        size="sm"
        label="Back 1 s"
        icon="−1s"
        onClick={() => scrubTo(Math.max(start, t - 1000))}
      />
      <IconButton
        size="sm"
        label="Forward 1 s"
        icon="+1s"
        onClick={() => scrubTo(Math.min(end, t + 1000))}
      />
      <div class="scrubber__track">
        <svg
          class="scrubber__density"
          viewBox={`0 0 ${BUCKETS} 20`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {density.map((v, i) => (
            <rect key={i} x={i} y={20 - (v / peak) * 20} width="0.9" height={(v / peak) * 20} />
          ))}
        </svg>
        <input
          type="range"
          aria-label="Replay time"
          min={start}
          max={end}
          step={10}
          value={t}
          onInput={(e) => {
            setPlaying(false)
            scrubTo(Number((e.currentTarget as HTMLInputElement).value))
          }}
        />
      </div>
      <span class="scrubber__time bh-mono" title={clock(t)}>
        {offset(t, start)} <span class="bh-muted">/ {offset(end, start)}</span>
      </span>
      <Button
        size="sm"
        variant={live.value ? 'primary' : 'secondary'}
        onClick={() => {
          setPlaying(false)
          goLive()
        }}
      >
        ● Live
      </Button>
    </footer>
  )
}
