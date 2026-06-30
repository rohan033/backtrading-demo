import { useCallback, useEffect, useMemo, useState } from 'react'
import type { IChartApi } from 'lightweight-charts'

import { chartBandRect } from '../../lib/chartBandGeometry'
import {
  buildChartSessionBands,
  type ChartSessionBand,
  type ChartSessionMarket,
} from '../../lib/homeChartSessionShading'

type RenderedBand = ChartSessionBand & {
  left: number
  width: number
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
      const geometry = chartBandRect(chart, band.fromTime, band.toTime)
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
