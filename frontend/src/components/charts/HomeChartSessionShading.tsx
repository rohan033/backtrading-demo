import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IChartApi, Time } from 'lightweight-charts'

import {
  buildChartSessionBands,
  type ChartSessionBand,
  type ChartSessionMarket,
} from '../../lib/homeChartSessionShading'

type RenderedBand = ChartSessionBand & {
  left: number
  width: number
}

type ChartTimeEdges = {
  from: number
  to: number
  width: number
}

function chartTimeEdges(chart: IChartApi): ChartTimeEdges | null {
  const width = chart.timeScale().width()
  if (width <= 0) return null

  const leftRaw = chart.timeScale().coordinateToTime(0)
  const rightRaw = chart.timeScale().coordinateToTime(width)
  if (leftRaw == null || rightRaw == null) return null

  const from = typeof leftRaw === 'number' ? leftRaw : Number(leftRaw)
  const to = typeof rightRaw === 'number' ? rightRaw : Number(rightRaw)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null

  return { from, to, width }
}

function timeToX(chart: IChartApi, edges: ChartTimeEdges, time: number): number | null {
  if (time < edges.from) return 0
  if (time > edges.to) return edges.width

  const direct = chart.timeScale().timeToCoordinate(time as Time)
  if (direct != null) return direct

  return ((time - edges.from) / (edges.to - edges.from)) * edges.width
}

function bandGeometry(
  chart: IChartApi,
  band: ChartSessionBand,
): { left: number; width: number } | null {
  const edges = chartTimeEdges(chart)
  if (!edges) return null

  const start = Math.max(band.fromTime, edges.from)
  const end = Math.min(band.toTime, edges.to)
  if (end <= start) return null

  const left = timeToX(chart, edges, start)
  const right = timeToX(chart, edges, end)
  if (left == null || right == null) return null

  const width = right - left
  if (width < 1) return null
  return { left, width }
}

type Props = {
  chartRef: React.RefObject<IChartApi | null>
  market: ChartSessionMarket
  fromTime?: number | null
  toTime?: number | null
  /** Bumps when the chart is (re)created or series data changes so overlays resync. */
  chartRevision?: string | number
}

export default function HomeChartSessionShading({
  chartRef,
  market,
  fromTime,
  toTime,
  chartRevision,
}: Props) {
  const [rendered, setRendered] = useState<RenderedBand[]>([])

  const sessionBands = useMemo(() => {
    if (fromTime == null || toTime == null) return []
    return buildChartSessionBands(fromTime, toTime, market)
  }, [fromTime, market, toTime])

  const updateRendered = useCallback(() => {
    const chart = chartRef.current
    if (!chart || !sessionBands.length) {
      setRendered([])
      return
    }

    const next: RenderedBand[] = []
    for (const band of sessionBands) {
      const geometry = bandGeometry(chart, band)
      if (!geometry) continue
      next.push({ ...band, ...geometry })
    }
    setRendered(next)
  }, [chartRef, sessionBands])

  useEffect(() => {
    updateRendered()
    const frame = window.requestAnimationFrame(updateRendered)
    return () => window.cancelAnimationFrame(frame)
  }, [updateRendered, chartRevision])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return undefined

    const handleRange = () => updateRendered()
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleRange)
    chart.timeScale().subscribeVisibleTimeRangeChange(handleRange)
    const observer = new ResizeObserver(handleRange)
    const host = chart.chartElement().parentElement
    if (host) observer.observe(host)

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleRange)
      chart.timeScale().unsubscribeVisibleTimeRangeChange(handleRange)
      observer.disconnect()
    }
  }, [chartRef, chartRevision, updateRendered])

  if (!rendered.length) return null

  return (
    <div className="hm-chart-session-layer" aria-hidden="true">
      {rendered.map(band => (
        <div
          key={`${band.session}-${band.fromTime}-${band.toTime}`}
          className={`hm-chart-session-band hm-chart-session-band--${band.session}`}
          style={{
            left: `${band.left}px`,
            width: `${band.width}px`,
          }}
        />
      ))}
    </div>
  )
}
