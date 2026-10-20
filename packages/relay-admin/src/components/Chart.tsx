/** @jsxImportSource preact */
import { useEffect, useRef } from 'preact/hooks'
import uPlot from 'uplot'

export interface ChartSeries {
  label: string
  color: string
  fill?: boolean
  value?: (v: number | null) => string
}

/** Thin uPlot wrapper: data is column-major [x[], y1[], y2[], ...]; resizes with its container. */
export function Chart({
  data,
  series,
  height = 180,
  xTime = true,
  yFormat,
}: {
  data: (number | null)[][]
  series: ChartSeries[]
  height?: number
  xTime?: boolean
  yFormat?: (v: number) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const plot = useRef<uPlot | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const css = getComputedStyle(document.documentElement)
    const grid = css.getPropertyValue('--bh-border').trim() || '#2A3050'
    const muted = css.getPropertyValue('--bh-text-muted').trim() || '#9AA0C3'
    const axis = {
      stroke: muted,
      grid: { stroke: grid, width: 1 },
      ticks: { stroke: grid, width: 1 },
      font: '11px system-ui',
    }
    const opts: uPlot.Options = {
      width: el.clientWidth || 300,
      height,
      cursor: { drag: { x: false, y: false } },
      legend: { show: true, live: true },
      scales: { x: { time: xTime } },
      axes: [
        { ...axis },
        {
          ...axis,
          size: 48,
          values: yFormat
            ? (_u, vals) => vals.map((v) => (v == null ? '' : yFormat(v)))
            : undefined,
        },
      ],
      series: [
        {},
        ...series.map((s) => ({
          label: s.label,
          stroke: s.color,
          width: 2,
          fill: s.fill ? `${s.color}22` : undefined,
          points: { show: false },
          value: s.value
            ? (_u: uPlot, v: number | null) => (s.value as (v: number | null) => string)(v)
            : undefined,
        })),
      ],
    }
    plot.current = new uPlot(opts, data as uPlot.AlignedData, el)
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height }))
        : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      plot.current?.destroy()
      plot.current = null
    }
  }, [series.length, height])

  useEffect(() => {
    plot.current?.setData(data as uPlot.AlignedData)
  }, [data])

  return <div ref={ref} class="w-full" />
}
