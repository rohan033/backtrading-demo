import { useEffect, useRef } from 'react'
import type { IPriceLine, ISeriesApi } from 'lightweight-charts'

import type { ChartOpportunityLevels } from '../../lib/chartOpportunityDetector'
import type { ChartLevelOverlay } from '../../lib/chartLevelOverlay'

type Props = {
  seriesRef: React.RefObject<ISeriesApi<'Line'> | null>
  enabled: boolean
  overlay: ChartLevelOverlay | null
  setupLevels: ChartOpportunityLevels | null
}

export default function ChartLevelLines({
  seriesRef,
  enabled,
  overlay,
  setupLevels,
}: Props) {
  const linesRef = useRef<IPriceLine[]>([])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return undefined

    linesRef.current.forEach(line => {
      try {
        series.removePriceLine(line)
      } catch {
        // series may have been torn down
      }
    })
    linesRef.current = []

    if (!enabled || !overlay) return undefined

    const next: IPriceLine[] = [
      series.createPriceLine({
        price: overlay.rangeHigh,
        color: 'rgba(198, 40, 40, 0.85)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Resistance',
      }),
      series.createPriceLine({
        price: overlay.rangeLow,
        color: 'rgba(46, 125, 50, 0.85)',
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: 'Support',
      }),
      series.createPriceLine({
        price: overlay.sma20,
        color: 'rgba(154, 154, 154, 0.9)',
        lineWidth: 1,
        lineStyle: 1,
        axisLabelVisible: true,
        title: 'SMA 20',
      }),
    ]

    if (setupLevels) {
      next.push(
        series.createPriceLine({
          price: setupLevels.entry,
          color: 'rgba(123, 97, 255, 0.95)',
          lineWidth: 1,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'Entry',
        }),
        series.createPriceLine({
          price: setupLevels.stop,
          color: 'rgba(255, 23, 68, 0.9)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Stop',
        }),
        series.createPriceLine({
          price: setupLevels.target,
          color: 'rgba(0, 200, 83, 0.9)',
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Target',
        }),
      )
    }

    linesRef.current = next

    return () => {
      linesRef.current.forEach(line => {
        try {
          series.removePriceLine(line)
        } catch {
          // ignore teardown races
        }
      })
      linesRef.current = []
    }
  }, [enabled, overlay, seriesRef, setupLevels])

  return null
}
