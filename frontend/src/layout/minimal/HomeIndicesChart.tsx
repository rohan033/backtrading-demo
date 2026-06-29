import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type Time,
} from 'lightweight-charts'

import { useHomeIndicesLiveFeed } from '../../hooks/useHomeIndicesLiveFeed'
import HomeChartRangeSelector, { type ChartTimeRange } from '../../components/charts/HomeChartRangeSelector'
import { loadHomeChartHistory } from '../../lib/homeChartHistory'
import {
  formatIndexHoverTime,
  formatIndexPrice,
  indexPriceAtTime,
  indexPriceLine,
  latestIndexPrice,
  resolveHomeIndices,
  type HomeIndexSymbol,
} from '../../lib/homeIndices'
import {
  applyHomeChartViewport,
  mergeLiveTickIntoWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '../../lib/watchlistCandles'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'

type HoverTipRow = {
  id: string
  label: string
  color: string
  price: number
}

type HoverTip = {
  time: number
  rows: HoverTipRow[]
}

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
  chartRange,
  onChartRangeChange,
  onAddRangeToChat,
  onClearChartRange,
}: {
  broker: WatchlistBroker
  accountEnv: string
  chartRange: ChartTimeRange | null
  onChartRangeChange: (range: ChartTimeRange | null) => void
  onAddRangeToChat: (range: ChartTimeRange) => void
  onClearChartRange: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<Map<string, ISeriesApi<'Line'>>>(new Map())
  const userInteractedRef = useRef(false)
  const lastAutoFitKeyRef = useRef<string | null>(null)
  const indicesRef = useRef<HomeIndexSymbol[]>([])
  const seriesCandlesRef = useRef<Record<string, WatchlistSanitizedCandle[]>>({})
  const hiddenIdsRef = useRef<Set<string>>(new Set())

  const [indices, setIndices] = useState<HomeIndexSymbol[]>([])
  const [seriesCandles, setSeriesCandles] = useState<Record<string, WatchlistSanitizedCandle[]>>({})
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set())
  const [legendVisible, setLegendVisible] = useState(true)
  const [hoverTip, setHoverTip] = useState<HoverTip | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const chartKey = `${broker}:${accountEnv}`

  const { ltps, streamStatus } = useHomeIndicesLiveFeed(
    indices,
    broker,
    accountEnv,
    indices.length > 0,
  )

  const liveSeriesCandles = useMemo(() => {
    const next: Record<string, WatchlistSanitizedCandle[]> = {}
    for (const index of indices) {
      const base = seriesCandles[index.id] ?? []
      next[index.id] = sortedUniqueCandles(
        mergeLiveTickIntoWatchlistCandles(base, ltps[index.id]),
      )
    }
    return next
  }, [indices, ltps, seriesCandles])

  indicesRef.current = indices
  seriesCandlesRef.current = liveSeriesCandles
  hiddenIdsRef.current = hiddenIds

  const streamBadgeClass = `hm-stream-badge hm-stream-badge--${
    streamStatus.tone === 'ok'
      ? 'ok'
      : streamStatus.tone === 'error'
        ? 'error'
        : streamStatus.tone === 'warn'
          ? 'warn'
          : 'idle'
  }`

  const seriesLines = useMemo(() => {
    const lines: Record<string, LineData[]> = {}
    for (const [id, candles] of Object.entries(liveSeriesCandles)) {
      lines[id] = indexPriceLine(candles)
    }
    return lines
  }, [liveSeriesCandles])

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
    setSeriesCandles({})
    setHiddenIds(new Set())
    setHoverTip(null)

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
              setSeriesCandles(prev => ({
                ...prev,
                [index.id]: sortedUniqueCandles(fresh),
              }))
            },
          }).then(candles => ({
            id: index.id,
            candles: sortedUniqueCandles(candles),
          }))),
        )
          .then(rows => {
            if (cancelled) return
            const nextCandles: Record<string, WatchlistSanitizedCandle[]> = {}
            for (const row of rows) nextCandles[row.id] = row.candles
            setSeriesCandles(nextCandles)
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
      price: latestIndexPrice(liveSeriesCandles[index.id] ?? []),
    })),
    [indices, liveSeriesCandles],
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
        visible: false,
        borderVisible: false,
      },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 1 },
    })
    chartRef.current = chart

    const crosshairHandler = (param: {
      time?: Time
      point?: { x: number; y: number }
    }) => {
      if (!param.time || !param.point) {
        setHoverTip(null)
        return
      }

      const time = typeof param.time === 'number'
        ? param.time
        : Number(param.time)
      if (!Number.isFinite(time)) {
        setHoverTip(null)
        return
      }

      const rows: HoverTipRow[] = []
      for (const index of indicesRef.current) {
        if (hiddenIdsRef.current.has(index.id)) continue
        const price = indexPriceAtTime(seriesCandlesRef.current[index.id] ?? [], time)
        if (price == null) continue
        rows.push({
          id: index.id,
          label: index.label,
          color: index.color,
          price,
        })
      }

      setHoverTip(rows.length ? { time, rows } : null)
    }

    chart.subscribeCrosshairMove(crosshairHandler)

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
      chart.unsubscribeCrosshairMove(crosshairHandler)
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
          priceScaleId: index.id,
          priceFormat: {
            type: 'price',
            precision: 2,
            minMove: 0.01,
          },
        })
        chart.priceScale(index.id).applyOptions({
          visible: false,
          borderVisible: false,
          scaleMargins: { top: 0.08, bottom: 0.12 },
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
    <>
      <div className="hm-chart-head hm-chart-head--indices">
        <div className="hm-chart-head__main">
          <div className="hm-chart-copy">
            <div className="hm-chart-title">US indices</div>
            <div className="hm-chart-subtitle">
              SPX500 · NSDQ100 · DJ30 · hover chart for history
            </div>
          </div>
        </div>
        <div className="hm-indices-head__aside">
          {indices.length ? (
            <span className={streamBadgeClass}>{streamStatus.label}</span>
          ) : null}
        </div>
      </div>

      <div className="hm-chart-body hm-chart-body--indices">
      <div className="hm-chart-host-wrap">
        <div ref={hostRef} className="hm-chart-host" />
        <HomeChartRangeSelector
          chartRef={chartRef}
          activeRange={chartRange}
          onRangeChange={onChartRangeChange}
          onAddToChat={onAddRangeToChat}
        />
        {legend.length ? (
          <div className="hm-indices-tooltip" aria-live="polite" aria-label="Index prices">
            {(hoverTip?.rows ?? legend
              .filter(item => !hiddenIds.has(item.id))
              .map(item => ({
                id: item.id,
                label: item.label,
                color: item.color,
                price: item.price,
              }))).map(row => (
              <div key={row.id} className="hm-indices-tooltip-row">
                <span
                  className="hm-indices-legend-dot"
                  style={{ backgroundColor: row.color }}
                  aria-hidden="true"
                />
                <span className="hm-indices-tooltip-label">{row.label}</span>
                <span className="hm-indices-tooltip-price">{formatIndexPrice(row.price)}</span>
              </div>
            ))}
            <div
              className={`hm-indices-tooltip-time${hoverTip ? '' : ' hm-indices-tooltip-time--placeholder'}`}
            >
              {hoverTip ? formatIndexHoverTime(hoverTip.time) : '00:00'}
            </div>
          </div>
        ) : null}
        {error ? <span className="hm-chart-label hm-chart-label--error">{error}</span> : null}
        {!error && loading && !maxLineCount ? (
          <span className="hm-chart-label">loading indices…</span>
        ) : null}
        {!error && !loading && !maxLineCount ? (
          <span className="hm-chart-label">No index history available</span>
        ) : null}
      </div>
      <div className="hm-chart-range-hint">
        <span>Shift+drag to select · right-click for options · Esc to clear</span>
        {chartRange ? (
          <button
            type="button"
            className="hm-chart-range-hint-clear"
            onClick={onClearChartRange}
          >
            Clear selection
          </button>
        ) : null}
      </div>
      {legend.length ? (
        <div className="hm-indices-legend-wrap">
          <button
            type="button"
            className="hm-indices-legend-toggle"
            onClick={() => setLegendVisible(visible => !visible)}
            aria-expanded={legendVisible}
          >
            {legendVisible ? 'Hide legend' : 'Show legend'}
          </button>
          {legendVisible ? (
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
                    <span className="hm-indices-legend-change">{formatIndexPrice(item.price)}</span>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      </div>
    </>
  )
}
