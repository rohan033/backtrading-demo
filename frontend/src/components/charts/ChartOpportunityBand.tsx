import { useCallback, useEffect, useState } from 'react'
import type { IChartApi } from 'lightweight-charts'

import { chartBandRect } from '../../lib/chartBandGeometry'
import type { ChartTimeRange } from './HomeChartRangeSelector'

type Props = {
  chartRef: React.RefObject<IChartApi | null>
  range: ChartTimeRange | null
  chartRevision?: string | number
  label?: string
  variant?: 'scan' | 'signal' | 'eureka' | 'levels' | 'setup'
}

export default function ChartOpportunityBand({
  chartRef,
  range,
  chartRevision,
  label = 'AI trade setup',
  variant = 'signal',
}: Props) {
  const [band, setBand] = useState<{ left: number; width: number } | null>(null)

  const updateBand = useCallback(() => {
    const chart = chartRef.current
    if (!chart || !range) {
      setBand(null)
      return false
    }

    const rect = chartBandRect(chart, range.fromTime, range.toTime)
    setBand(rect)
    return rect != null
  }, [chartRef, range])

  useEffect(() => {
    if (!range) {
      setBand(null)
      return undefined
    }

    let cancelled = false
    let attempts = 0

    const tryUpdate = () => {
      if (cancelled) return
      const ok = updateBand()
      attempts += 1
      if (!ok && attempts < 12) {
        window.requestAnimationFrame(tryUpdate)
      }
    }

    tryUpdate()
    const retryTimer = window.setInterval(() => {
      if (updateBand()) window.clearInterval(retryTimer)
    }, 250)

    return () => {
      cancelled = true
      window.clearInterval(retryTimer)
    }
  }, [chartRevision, range, updateBand])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !range) return undefined

    const handleRange = () => updateBand()
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
  }, [chartRef, chartRevision, range, updateBand])

  if (!band) return null

  return (
    <div className={`hm-chart-opportunity-layer hm-chart-opportunity-layer--${variant}`} aria-hidden="true">
      <div
        className={`hm-chart-opportunity-band hm-chart-opportunity-band--${variant}`}
        style={{ left: `${band.left}px`, width: `${band.width}px` }}
      />
      <div
        className={`hm-chart-opportunity-label hm-chart-opportunity-label--${variant}`}
        style={{ left: `${Math.max(0, band.left + 6)}px` }}
      >
        {label}
      </div>
    </div>
  )
}
