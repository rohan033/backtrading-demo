import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
} from 'lightweight-charts'

import { loadHomeChartHistory } from '../../lib/homeChartHistory'
import {
  formatIndexChangePct,
  indexPercentLine,
  latestIndexChange,
  resolveHomeIndices,
  type HomeIndexSymbol,
} from '../../lib/homeIndices'
import {
  applyHomeChartViewport,
  type WatchlistSanitizedCandle,
} from '../../lib/watchlistCandles'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'

function sortedUniqueCandles(candles: WatchlistSanitizedCandle[]): WatchlistSanitizedCandle[] {
  const byTime = new Map<number, WatchlistSanitizedCandle>()
  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) continue
    byTime.set(candle.time, candle)
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

function IndexVisibilityIcon({ visible }: { visible: boolean }) {
  if (visible) {
    return (
      <svg className="hm-indices-visibility-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 5C7 5 2.73 8.11 1 12c1.73 3.89 6 7 11 7s9.27-3.11 11-7c-1.73-3.89-6-7-11-7Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    )
  }

  return (
    <svg className="hm-indices-visibility-icon" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M3 3l18 18M10.6 10.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-4.4M6.7 6.7C4.5 8.1 2.8 10 1 12c1.73 3.89 6 7 11 7 1.6 0 3.1-.35 4.5-.95M9.9 4.24A10.8 10.8 0 0 1 12 5c5 0 9.27 3.11 11 7a11.6 11.6 0 0 1-2.08 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

export default function HomeIndicesChart({
  broker,
  accountEnv,
}: {
  broker: WatchlistBroker
  accountEnv: string
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const userInteractedRef = useRef(false)
  const lastAutoFitKeyRef = useRef<string | null>(null)

  const [indices, setIndices] = useState<HomeIndexSymbol[]>([])
  const [seriesLines, setSeriesLines] = useState<Record<string, LineData[]>>({})
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const chartKey = `${broker}:${accountEnv}`

  const toggleIndexVisibility = (id: string) => {
    setHiddenIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setIndices([])
    setSeriesLines({})
    setHiddenIds(new Set())

    void resolveHomeIndices(broker, accountEnv)
      .then(resolved => {
        if (cancelled) return
        if (!resolved.length) {
          setError('Could not resolve US index symbols for this broker.')
          return
        }
        setIndices(resolved)

        void Promise.all(
          resolved.map(index => loadHomeChartHistory({
            tickKey: index.tickKey,
            watchlistId: 'home-indices',
            broker,
            accountEnv,
            tradingsymbol: index.tradingsymbol,
            symboltoken: index.symboltoken,
            exchange: index.exchange,
          }, {
            onRefresh: fresh => {
              if (cancelled || !fresh.length) return
              setSeriesLines(prev => ({
                ...prev,
                [index.id]: indexPercentLine(sortedUniqueCandles(fresh)),
              }))
            },
          }).then(candles => ({
            id: index.id,
            line: indexPercentLine(sortedUniqueCandles(candles)),
          }))),
        )
          .then(rows => {
            if (cancelled) return
            const nextLines: Record<string, LineData[]> = {}
            for (const row of rows) nextLines[row.id] = row.line
            setSeriesLines(nextLines)
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load indices')
          setLoading(false)
        }
      })

    return () => { cancelled = true }
  }, [accountEnv, broker, chartKey])

  const legend = useMemo(
    () => indices.map(index => ({
      ...index,
      change: latestIndexChange(seriesLines[index.id] ?? []),
    })),
    [indices, seriesLines],
  )

  const maxLineCount = useMemo(
    () => Math.max(0, ...Object.values(seriesLines).map(line => line.length)),
    [seriesLines],
  )

  useEffect(() => {
    const el = hostRef.current
    if (!el) return

    userInteractedRef.current = false
    lastAutoFitKeyRef.current = null
    seriesRef.current.clear()

    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: Math.max(120, el.clientHeight),
      attributionLogo: false,
      layout: { background: { color: '#FFFFFF' }, textColor: '#9A9A9A' },
      grid: {
        vertLines: { color: '#F1F1F1' },
        horzLines: { color: '#F1F1F1' },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.08, bottom: 0.12 },
      },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const resize = () => {
      chart.applyOptions({
        width: Math.max(1, el.clientWidth),
        height: Math.max(120, el.clientHeight),
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    const markUserInteracted = () => { userInteractedRef.current = true }
    el.addEventListener('wheel', markUserInteracted, { passive: true })
    el.addEventListener('pointerdown', markUserInteracted)

    return () => {
      el.removeEventListener('wheel', markUserInteracted)
      el.removeEventListener('pointerdown', markUserInteracted)
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current.clear()
    }
  }, [chartKey])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    for (const index of indices) {
      let series = seriesRef.current.get(index.id)
      if (!series) {
        series = chart.addLineSeries({
          color: index.color,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          title: index.label,
        })
        seriesRef.current.set(index.id, series)
      }
      const visible = !hiddenIds.has(index.id)
      series.applyOptions({ visible, color: index.color })
      series.setData(visible ? (seriesLines[index.id] ?? []) : [])
    }

    const visibleLineCount = indices.reduce((max, index) => {
      if (hiddenIds.has(index.id)) return max
      return Math.max(max, seriesLines[index.id]?.length ?? 0)
    }, 0)

    const autoFitKey = `${chartKey}:${visibleLineCount}:${[...hiddenIds].sort().join(',')}`
    if (visibleLineCount && !userInteractedRef.current && lastAutoFitKeyRef.current !== autoFitKey) {
      applyHomeChartViewport(chart, visibleLineCount)
      lastAutoFitKeyRef.current = autoFitKey
    }
  }, [chartKey, hiddenIds, indices, seriesLines])

  return (
    <div className="hm-chart-body hm-chart-body--indices">
      <div className="hm-chart-host-wrap">
        <div ref={hostRef} className="hm-chart-host" />
        {error ? <span className="hm-chart-label hm-chart-label--error">{error}</span> : null}
        {!error && loading && !maxLineCount ? (
          <span className="hm-chart-label">loading indices…</span>
        ) : null}
        {!error && !loading && !maxLineCount ? (
          <span className="hm-chart-label">No index history available</span>
        ) : null}
      </div>
      {legend.length ? (
        <div className="hm-indices-legend" aria-label="Index legend">
          {legend.map(item => {
            const visible = !hiddenIds.has(item.id)
            return (
              <button
                key={item.id}
                type="button"
                className={`hm-indices-legend-item${visible ? '' : ' hm-indices-legend-item--hidden'}`}
                onClick={() => toggleIndexVisibility(item.id)}
                aria-pressed={visible}
                title={visible ? `Hide ${item.label}` : `Show ${item.label}`}
              >
                <IndexVisibilityIcon visible={visible} />
                <span
                  className="hm-indices-legend-dot"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
                <span className="hm-indices-legend-label">{item.label}</span>
                <span className="hm-indices-legend-change">{formatIndexChangePct(item.change)}</span>
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
