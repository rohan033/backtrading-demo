import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts'

import { focusTickKey } from '@/hooks/useAgentThreadFocus'
import type { WatchlistBroker } from '@/lib/watchlistBrokers'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import { defaultAccountEnv } from '@/lib/watchlistBrokers'
import { loadHomeChartHistory } from '@/lib/homeChartHistory'
import { applyHomeChartViewport } from '@/lib/watchlistCandles'
import type { MarketStreamStatus } from '@/lib/useControlMarketStream'
import type { PriceSample } from '@/lib/watchlistChangeColumns'
import type { WatchlistChartSymbol } from '@/lib/watchlistUniqueSymbols'
import {
  mergeLiveTickIntoWatchlistCandles,
  mergeWatchlistCandleHistory,
  samplesToWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '@/lib/watchlistCandles'

type Props = {
  focus: AgentThreadFocus
  ltp: number | null
  streamStatus: MarketStreamStatus
}

const MIN_HISTORY_BARS = 30

export default function AgentFocusChart({ focus, ltp, streamStatus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const lastPointRef = useRef<LineData | null>(null)
  const lastViewportBarsRef = useRef(0)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [liveSamples, setLiveSamples] = useState<PriceSample[]>([])
  const [loading, setLoading] = useState(true)

  const broker = (focus.broker || 'etoro') as WatchlistBroker
  const accountEnv = focus.account_env || defaultAccountEnv(broker)
  const tickKey = focusTickKey({ ...focus, broker, account_env: accountEnv })

  const chartSymbol = useMemo((): WatchlistChartSymbol | null => {
    if (!focus.symbol) return null
    return {
      tickKey,
      watchlistId: 'agent',
      broker,
      accountEnv,
      tradingsymbol: focus.symbol,
      symboltoken: String(focus.token || focus.symbol),
      exchange: focus.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
    }
  }, [accountEnv, broker, focus.exchange, focus.symbol, focus.token, tickKey])

  useEffect(() => {
    setLiveSamples([])
    setCandles([])
  }, [tickKey])

  useEffect(() => {
    if (ltp == null || !Number.isFinite(ltp) || ltp <= 0) return
    setLiveSamples(prev => [...prev, { ts: Date.now(), ltp }].slice(-2000))
  }, [ltp])

  useEffect(() => {
    if (!chartSymbol) {
      setLoading(false)
      return undefined
    }

    let cancelled = false
    setLoading(true)

    const applyRows = (rows: WatchlistSanitizedCandle[]) => {
      if (!cancelled && rows.length) setCandles(rows)
    }

    void loadHomeChartHistory(chartSymbol, {
      onRefresh: applyRows,
    })
      .then(async rows => {
        if (cancelled) return
        if (rows.length) {
          setCandles(rows)
          return
        }
        const retry = await loadHomeChartHistory(chartSymbol, { force: true })
        if (!cancelled && retry.length) setCandles(retry)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [chartSymbol])

  const displayCandles = useMemo(() => {
    const base = candles.length >= MIN_HISTORY_BARS
      ? candles
      : mergeWatchlistCandleHistory(
        samplesToWatchlistCandles(liveSamples),
        candles,
      )
    return mergeLiveTickIntoWatchlistCandles(base, ltp)
  }, [candles, liveSamples, ltp])

  const lineData = useMemo(
    () => displayCandles.map(row => ({
      time: row.time as LineData['time'],
      value: row.close,
    })),
    [displayCandles],
  )

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: Math.max(120, el.clientHeight),
      attributionLogo: false,
      layout: { background: { color: '#FFFFFF' }, textColor: '#9A9A9A' },
      grid: {
        vertLines: { color: '#F1F1F1' },
        horzLines: { color: '#F1F1F1' },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
    })
    chartRef.current = chart
    const line = chart.addLineSeries({ color: '#6295D6', lineWidth: 2 })
    lineRef.current = line
    lastViewportBarsRef.current = 0
    const resize = () => {
      chart.applyOptions({
        width: Math.max(1, el.clientWidth),
        height: Math.max(120, el.clientHeight),
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
      lineRef.current = null
      lastPointRef.current = null
      lastViewportBarsRef.current = 0
    }
  }, [tickKey])

  useEffect(() => {
    const line = lineRef.current
    const chart = chartRef.current
    if (!line || !lineData.length) {
      line?.setData([])
      lastPointRef.current = null
      return
    }

    const lastPoint = lineData[lineData.length - 1]
    const previous = lastPointRef.current
    const incremental = previous
      && (previous.time === lastPoint.time
        || (lastPoint.time > previous.time
          && lineData[lineData.length - 2]?.time === previous.time))

    if (incremental) {
      line.update(lastPoint)
    } else {
      line.setData(lineData)
      if (lineData.length !== lastViewportBarsRef.current) {
        applyHomeChartViewport(chart, lineData.length)
        lastViewportBarsRef.current = lineData.length
      }
    }
    lastPointRef.current = lastPoint
  }, [lineData])

  const close = focus.close_price != null ? Number(focus.close_price) : null
  const longPct = focus.long_percent != null ? Number(focus.long_percent) : null
  const shortPct = focus.short_percent != null ? Number(focus.short_percent) : null
  const displayLtp = ltp ?? close
  const historyThin = !loading && candles.length < MIN_HISTORY_BARS

  return (
    <section className="am-trading-chart">
      <div className="am-trading-chart__header">
        <span className="am-trading-chart__symbol">{focus.symbol}</span>
        {displayLtp != null ? (
          <span className="am-trading-chart__ltp">{displayLtp.toFixed(2)}</span>
        ) : null}
        <span className={`am-feed-status am-feed-status--${streamStatus.tone}`}>
          {streamStatus.label}
        </span>
      </div>
      <div className="am-trading-chart__host" ref={hostRef} />
      {close != null ? (
        <div className="am-trading-chart__levels">
          {longPct != null ? <span>Target {((close * (100 + longPct)) / 100).toFixed(2)}</span> : null}
          <span>Entry {close.toFixed(2)}</span>
          {shortPct != null ? <span>Stop {((close * (100 - shortPct)) / 100).toFixed(2)}</span> : null}
        </div>
      ) : null}
      {loading ? <div className="am-trading-chart__loading">Loading chart…</div> : null}
      {!loading && historyThin ? (
        <div className="am-trading-chart__history-hint">
          {candles.length ? 'Loading older bars…' : 'Building chart from live ticks…'}
        </div>
      ) : null}
    </section>
  )
}
