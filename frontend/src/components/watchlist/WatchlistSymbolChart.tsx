import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
} from 'lightweight-charts'
import { Maximize2, Zap } from 'lucide-react'

import { formatBrokerMoney } from '../../lib/currency'
import type { WatchlistChangeWindowId } from '../../lib/watchlistChangeColumns'
import { WATCHLIST_CHANGE_WINDOWS, windowChangeTone } from '../../lib/watchlistChangeColumns'
import type { WatchlistWindowChanges } from '../../hooks/useWatchlistPriceHistory'
import { momentumSymbolKey } from '../../lib/watchlistMomentumState'
import type { PriceSample } from '../../lib/watchlistChangeColumns'
import { samplesToChartPoints } from '../../lib/watchlistFeedReuse'
import {
  applyWatchlistCandleColors,
  applyWatchlistCandleViewport,
  candlesToVolumeData,
  WATCHLIST_CANDLE_DOWN,
  WATCHLIST_CANDLE_UP,
  type WatchlistSanitizedCandle,
} from '../../lib/watchlistCandles'
import type { WatchlistChartRenderMode } from '../../lib/watchlistViewMode'
import type { WatchlistBroker } from '../../lib/watchlistBrokers'
import type { WatchlistTick } from '../../lib/watchlists'

type Props = {
  watchlistId: string
  tickKey: string
  symboltoken: string
  label: string
  broker: WatchlistBroker
  samples: PriceSample[]
  candles?: WatchlistSanitizedCandle[]
  tick?: WatchlistTick | null
  renderMode: WatchlistChartRenderMode
  visibleChangeColumns: WatchlistChangeWindowId[]
  windowChanges: WatchlistWindowChanges
  momentumSymbolKeys?: Set<string>
  momentumNoTpSymbolKeys?: Set<string>
  momentumLiveSymbolKeys?: Set<string>
  onToggleSymbolMomentum?: (watchlistId: string, symboltoken: string) => void
  onToggleSymbolMomentumNoTp?: (watchlistId: string, symboltoken: string) => void
  onToggleSymbolMomentumLive?: (watchlistId: string, symboltoken: string) => void
  height?: number
  fillParent?: boolean
  compact?: boolean
  highlighted?: boolean
  showMaximize?: boolean
  onMaximize?: () => void
  onSelect?: () => void
}

function chartPoints(samples: PriceSample[], liveLtp?: number | null): LineData[] {
  const points = samplesToChartPoints(samples)
  if (points.length) return points as LineData[]

  const price = Number(liveLtp)
  if (!Number.isFinite(price) || price <= 0) return []

  const now = Math.floor(Date.now() / 1000)
  return [
    { time: now - 180, value: price },
    { time: now - 60, value: price },
    { time: now, value: price },
  ]
}

function changeBadgeClass(value: number | null | undefined, compact: boolean): string {
  const base = `rounded px-1 py-0.5 font-sans tabular-nums ${compact ? 'text-[8px]' : 'text-[9px]'}`
  if (value == null || Number.isNaN(value)) return `${base} text-text-secondary/50`
  const tone = windowChangeTone(value)
  if (tone === 'up') return `${base} font-semibold text-green bg-green/12`
  if (tone === 'down') return `${base} font-semibold text-red bg-red/12`
  if (tone === 'flat') return `${base} text-text-secondary bg-muted/25`
  return `${base} text-text-secondary/60`
}

function rowHighlightClass(
  momentumOn: boolean,
  momentumNoTpOn: boolean,
  momentumLiveOn: boolean,
): string {
  if (momentumLiveOn || momentumNoTpOn) {
    return 'bg-red/[0.13] ring-1 ring-inset ring-red/30'
  }
  if (momentumOn) {
    return 'bg-amber-500/[0.13] ring-1 ring-inset ring-amber-500/35'
  }
  return ''
}

export default function WatchlistSymbolChart({
  watchlistId,
  tickKey,
  symboltoken,
  label,
  broker,
  samples,
  candles = [],
  tick,
  renderMode,
  visibleChangeColumns,
  windowChanges,
  momentumSymbolKeys,
  momentumNoTpSymbolKeys,
  momentumLiveSymbolKeys,
  onToggleSymbolMomentum,
  onToggleSymbolMomentumNoTp,
  onToggleSymbolMomentumLive,
  height,
  fillParent = false,
  compact = false,
  highlighted = false,
  showMaximize = false,
  onMaximize,
  onSelect,
}: Props) {
  const shellRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const plotRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const candlesRef = useRef<WatchlistSanitizedCandle[]>([])
  const lastPointRef = useRef<LineData | WatchlistSanitizedCandle | null>(null)
  const userInteractedRef = useRef(false)
  const [plotHeight, setPlotHeight] = useState(compact ? 72 : 280)

  const isCandleMode = renderMode === 'candle'
  const lineData = useMemo(() => chartPoints(samples, tick?.ltp), [samples, tick?.ltp])
  const candleData = useMemo(() => candles, [candles])

  useEffect(() => {
    candlesRef.current = candleData
  }, [candleData])
  const ltp = tick?.ltp
  const symbolWindows = windowChanges[tickKey]

  const momentumKey = momentumSymbolKey(watchlistId, symboltoken)
  const symbolMomentumOn = momentumSymbolKeys?.has(momentumKey) ?? false
  const symbolMomentumNoTpOn = momentumNoTpSymbolKeys?.has(momentumKey) ?? false
  const symbolMomentumLiveOn = momentumLiveSymbolKeys?.has(momentumKey) ?? false

  const windowLabels = useMemo(
    () => new Map(WATCHLIST_CHANGE_WINDOWS.map(window => [window.id, window.label])),
    [],
  )

  useEffect(() => {
    const shell = shellRef.current
    const toolbar = toolbarRef.current
    if (!shell || !toolbar) return undefined

    const update = () => {
      const toolbarHeight = toolbar.offsetHeight
      if (fillParent) {
        setPlotHeight(Math.max(compact ? 56 : 200, shell.clientHeight - toolbarHeight))
        return
      }
      if (height) {
        setPlotHeight(Math.max(compact ? 56 : 120, height - toolbarHeight))
      }
    }

    update()
    const observer = new ResizeObserver(update)
    observer.observe(shell)
    observer.observe(toolbar)
    return () => observer.disconnect()
  }, [fillParent, height, compact, visibleChangeColumns.length, renderMode])

  useEffect(() => {
    const container = plotRef.current
    if (!container || plotHeight <= 0) return undefined

    userInteractedRef.current = false
    lastPointRef.current = null

    const markUserInteracted = () => {
      userInteractedRef.current = true
    }
    container.addEventListener('wheel', markUserInteracted, { passive: true })
    container.addEventListener('pointerdown', markUserInteracted)

    let chart: IChartApi | null = null
    let resizeObserver: ResizeObserver | null = null
    let cancelled = false

    const mount = () => {
      if (cancelled || !plotRef.current) return
      const width = plotRef.current.clientWidth
      if (width <= 0) {
        requestAnimationFrame(mount)
        return
      }

      chart = createChart(plotRef.current, {
        width,
        height: plotHeight,
        layout: { background: { color: '#111d28' }, textColor: '#8899a6' },
        grid: { vertLines: { color: '#1a2733' }, horzLines: { color: '#1a2733' } },
        timeScale: {
          timeVisible: true,
          secondsVisible: !isCandleMode,
          borderColor: '#2a3f52',
          barSpacing: isCandleMode ? (compact ? 1 : 7) : compact ? 2 : 4,
          minBarSpacing: isCandleMode ? (compact ? 0.5 : 2) : compact ? 1 : 2,
          rightOffset: isCandleMode ? (compact ? 2 : 4) : 4,
        },
        rightPriceScale: {
          borderColor: '#2a3f52',
          autoScale: true,
          scaleMargins: isCandleMode ? { top: 0.05, bottom: 0.28 } : { top: 0.1, bottom: 0.18 },
        },
        handleScroll: !compact,
        handleScale: !compact,
      })

      if (isCandleMode) {
        candleSeriesRef.current = chart.addCandlestickSeries({
          upColor: WATCHLIST_CANDLE_UP,
          downColor: WATCHLIST_CANDLE_DOWN,
          borderUpColor: WATCHLIST_CANDLE_UP,
          borderDownColor: WATCHLIST_CANDLE_DOWN,
          wickUpColor: WATCHLIST_CANDLE_UP,
          wickDownColor: WATCHLIST_CANDLE_DOWN,
        })
        volumeSeriesRef.current = chart.addHistogramSeries({
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
        })
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.78, bottom: 0 },
        })
        lineSeriesRef.current = null
      } else {
        lineSeriesRef.current = chart.addLineSeries({
          color: '#f0b840',
          lineWidth: compact ? 1 : 2,
          priceLineVisible: false,
          lastValueVisible: !compact,
        })
        candleSeriesRef.current = null
        volumeSeriesRef.current = null
      }

      chartRef.current = chart

      resizeObserver = new ResizeObserver(() => {
        if (!plotRef.current || !chartRef.current) return
        const nextWidth = plotRef.current.clientWidth
        if (nextWidth > 0) chartRef.current.resize(nextWidth, plotHeight)
      })
      resizeObserver.observe(plotRef.current)
    }

    mount()

    return () => {
      cancelled = true
      container.removeEventListener('wheel', markUserInteracted)
      container.removeEventListener('pointerdown', markUserInteracted)
      resizeObserver?.disconnect()
      chart?.remove()
      chartRef.current = null
      lineSeriesRef.current = null
      candleSeriesRef.current = null
      volumeSeriesRef.current = null
      lastPointRef.current = null
    }
  }, [plotHeight, compact, isCandleMode, label])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    if (isCandleMode) {
      const series = candleSeriesRef.current
      const volumeSeries = volumeSeriesRef.current
      if (!series) return
      if (!candleData.length) {
        series.setData([])
        volumeSeries?.setData([])
        lastPointRef.current = null
        return
      }
      const lastCandle = candleData[candleData.length - 1]
      const previous = lastPointRef.current as WatchlistSanitizedCandle | null
      const volumeData = candlesToVolumeData(candleData)
      const lastVolume = volumeData[volumeData.length - 1]
      if (previous && lastCandle.time === previous.time) {
        series.update(lastCandle)
        volumeSeries?.update(lastVolume)
      } else if (
        previous
        && lastCandle.time > previous.time
        && candleData[candleData.length - 2]?.time === previous.time
      ) {
        series.update(lastCandle)
        volumeSeries?.update(lastVolume)
      } else {
        series.setData(candleData)
        volumeSeries?.setData(volumeData)
      }
      applyWatchlistCandleColors(series, lastCandle)
      lastPointRef.current = lastCandle
      if (!userInteractedRef.current) {
        applyWatchlistCandleViewport(chart, candleData.length, compact)
      }
      return
    }

    const series = lineSeriesRef.current
    if (!series) return
    if (!lineData.length) {
      series.setData([])
      lastPointRef.current = null
      return
    }
    const lastPoint = lineData[lineData.length - 1]
    const previous = lastPointRef.current as LineData | null
    if (previous && lastPoint.time === previous.time) {
      series.update(lastPoint)
    } else {
      series.setData(lineData)
    }
    lastPointRef.current = lastPoint

    if (!userInteractedRef.current) {
      chart.timeScale().fitContent()
    }
  }, [lineData, candleData, isCandleMode, compact])

  const tickPct = tick?.change_pct
  const highlight = rowHighlightClass(symbolMomentumOn, symbolMomentumNoTpOn, symbolMomentumLiveOn)

  return (
    <div
      ref={shellRef}
      className={`flex min-w-0 flex-col overflow-hidden rounded-lg border shadow-panel transition-colors ${
        highlighted ? 'border-accent/50 ring-1 ring-accent/30' : 'border-border'
      } ${highlight} ${fillParent ? 'h-full bg-card/80' : 'bg-card/80'}`}
      style={fillParent ? undefined : height ? { height } : undefined}
    >
      <div ref={toolbarRef} className="shrink-0 border-b border-border/60 px-2 py-1.5">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onSelect}
            className={`min-w-0 truncate text-left text-[11px] font-bold text-text-primary ${onSelect ? 'hover:text-accent' : ''}`}
            title={label}
          >
            {label}
          </button>
          <div className="flex shrink-0 items-center gap-1">
            {ltp != null ? (
              <span className="font-mono text-[10px] tabular-nums text-text-secondary">
                {formatBrokerMoney(broker, ltp, 2)}
              </span>
            ) : null}
            {showMaximize ? (
              <button
                type="button"
                onClick={event => {
                  event.stopPropagation()
                  onMaximize?.()
                }}
                className="rounded p-0.5 text-text-secondary transition-colors hover:bg-card-hi hover:text-accent"
                title="Maximize chart"
              >
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-1">
          {visibleChangeColumns.map(columnId => {
            const value = symbolWindows?.[columnId] ?? null
            return (
              <span
                key={columnId}
                className={changeBadgeClass(value, compact)}
                title={windowLabels.get(columnId)}
              >
                {windowLabels.get(columnId)}{' '}
                {value == null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`}
              </span>
            )
          })}
          <span className={changeBadgeClass(tickPct ?? null, compact)} title="Tick">
            Tick {tickPct == null ? '—' : `${tickPct > 0 ? '+' : ''}${tickPct.toFixed(2)}%`}
          </span>
        </div>

        <div className="mt-1 flex items-center justify-end gap-0.5">
          {onToggleSymbolMomentumLive ? (
            <button
              type="button"
              role="switch"
              aria-checked={symbolMomentumLiveOn}
              aria-label={symbolMomentumLiveOn ? 'Live deploy' : 'Demo deploy'}
              onClick={event => {
                event.stopPropagation()
                onToggleSymbolMomentumLive(watchlistId, symboltoken)
              }}
              className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                symbolMomentumLiveOn
                  ? 'bg-red ring-1 ring-inset ring-red/50'
                  : 'bg-green ring-1 ring-inset ring-green/50'
              }`}
              title={symbolMomentumLiveOn ? 'Live — click for demo' : 'Demo — click for live'}
            >
              <span
                className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow-sm transition-transform duration-200 ease-out ${
                  symbolMomentumLiveOn ? 'translate-x-[18px]' : 'translate-x-[2px]'
                }`}
              />
            </button>
          ) : null}
          {onToggleSymbolMomentum ? (
            <button
              type="button"
              onClick={() => onToggleSymbolMomentum(watchlistId, symboltoken)}
              title={symbolMomentumOn ? 'Momentum armed — click to disable' : 'Arm momentum (5% TP / 1% SL)'}
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                symbolMomentumOn
                  ? 'bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/50'
                  : 'text-text-secondary hover:bg-amber-500/10 hover:text-amber-400'
              }`}
            >
              <Zap className="h-3 w-3" />
            </button>
          ) : null}
          {onToggleSymbolMomentumNoTp ? (
            <button
              type="button"
              onClick={() => onToggleSymbolMomentumNoTp(watchlistId, symboltoken)}
              title={symbolMomentumNoTpOn ? 'No-TP momentum armed — click to disable' : 'Arm no-TP momentum'}
              className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors ${
                symbolMomentumNoTpOn
                  ? 'bg-blue-500/20 text-blue-300 ring-1 ring-blue-500/50'
                  : 'text-text-secondary hover:bg-blue-500/10 hover:text-blue-400'
              }`}
            >
              <Zap className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      </div>

      <div ref={plotRef} className="min-h-0 w-full shrink-0" style={{ height: plotHeight }} />
    </div>
  )
}
