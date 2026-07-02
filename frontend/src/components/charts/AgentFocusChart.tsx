import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts'

import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'
import type { CandidateLiveFeed } from '@/hooks/useMultiSymbolLiveFeeds'
import { focusTickKey } from '@/hooks/useAgentThreadFocus'
import { mergeHistoryWithLiveTail } from '@/lib/agentChartLiveLine'
import type { WatchlistBroker } from '@/lib/watchlistBrokers'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import { defaultAccountEnv } from '@/lib/watchlistBrokers'
import { loadHomeChartHistory } from '@/lib/homeChartHistory'
import { applyHomeChartViewport } from '@/lib/watchlistCandles'
import type { MarketStreamStatus } from '@/lib/useControlMarketStream'
import type { WatchlistChartSymbol } from '@/lib/watchlistUniqueSymbols'
import type { HomeChartMonitorMarker } from '@/lib/homeChartMonitorMarkers'
import type { WatchlistSanitizedCandle } from '@/lib/watchlistCandles'

type Props = {
  focus: AgentThreadFocus
  ltp?: number | null
  streamStatus?: MarketStreamStatus
  monitorMarkers?: HomeChartMonitorMarker[]
  /** Shared per-symbol feed from workspace — same pipeline as TopStockPicks mini charts */
  liveFeed?: CandidateLiveFeed | null
}

const IDLE_STREAM: MarketStreamStatus = { status: 'idle', label: '—', tone: 'muted' }

export default function AgentFocusChart({
  focus,
  ltp: ltpProp = null,
  streamStatus: streamStatusProp,
  monitorMarkers = [],
  liveFeed = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const lastPointRef = useRef<LineData | null>(null)
  const lastViewportBarsRef = useRef(0)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [loading, setLoading] = useState(true)

  const broker = (focus.broker || 'etoro') as WatchlistBroker
  const accountEnv = focus.account_env || defaultAccountEnv(broker)

  const internalLive = useCandidateChartLive({
    symbol: focus.symbol || '',
    token: focus.token,
    exchange: focus.exchange,
    broker,
    accountEnv,
    enabled: !liveFeed && Boolean(focus.symbol),
  })

  const live = liveFeed ?? {
    symbol: focus.symbol || '',
    tickKey: internalLive.tickKey,
    feedToken: internalLive.feedToken,
    resolvedExchange: internalLive.resolvedExchange,
    ltp: internalLive.ltp,
    streamStatus: internalLive.streamStatus,
    connected: internalLive.connected,
    samples: internalLive.samples,
    resolving: internalLive.resolving,
    focus,
  }

  const displayLtp = live.ltp ?? ltpProp
  const streamStatus = live.streamStatus ?? streamStatusProp ?? IDLE_STREAM
  const tickKey = live.tickKey || focusTickKey({ ...focus, broker, account_env: accountEnv })

  const chartSymbol = useMemo((): WatchlistChartSymbol | null => {
    if (!focus.symbol) return null
    const token = live.feedToken || focus.token || focus.symbol
    return {
      tickKey,
      watchlistId: 'agent',
      broker,
      accountEnv,
      tradingsymbol: focus.symbol,
      symboltoken: String(token),
      exchange: live.resolvedExchange || focus.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
    }
  }, [
    accountEnv,
    broker,
    focus.exchange,
    focus.symbol,
    focus.token,
    live.feedToken,
    live.resolvedExchange,
    tickKey,
  ])

  useEffect(() => {
    setCandles([])
  }, [tickKey])

  useEffect(() => {
    if (!chartSymbol) {
      setLoading(false)
      return undefined
    }
    if (broker === 'etoro' && !live.feedToken && live.resolving) {
      return undefined
    }

    let cancelled = false
    setLoading(true)

    const applyRows = (rows: WatchlistSanitizedCandle[]) => {
      if (!cancelled && rows.length) setCandles(rows)
    }

    void loadHomeChartHistory(chartSymbol, { onRefresh: applyRows })
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
  }, [broker, chartSymbol, live.feedToken, live.resolving])

  const lineData = useMemo(
    () => mergeHistoryWithLiveTail(candles, live.samples, displayLtp),
    [candles, displayLtp, live.samples],
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
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true },
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
      chart?.timeScale().scrollToRealTime()
    } else {
      line.setData(lineData)
      if (lineData.length !== lastViewportBarsRef.current) {
        applyHomeChartViewport(chart, lineData.length)
        lastViewportBarsRef.current = lineData.length
      }
    }
    lastPointRef.current = lastPoint
  }, [displayLtp, lineData, live.samples.length])

  useEffect(() => {
    const line = lineRef.current
    if (!line) return
    line.setMarkers(monitorMarkers)
  }, [monitorMarkers])

  const close = focus.close_price != null ? Number(focus.close_price) : null
  const longPct = focus.long_percent != null ? Number(focus.long_percent) : null
  const shortPct = focus.short_percent != null ? Number(focus.short_percent) : null
  const historyThin = !loading && !lineData.length && candles.length < 30

  return (
    <section className="am-trading-chart">
      <div className="am-trading-chart__header">
        <span className="am-trading-chart__symbol">{focus.symbol}</span>
        {displayLtp != null ? (
          <span className="am-trading-chart__ltp">{displayLtp.toFixed(2)}</span>
        ) : null}
        <span className={`am-feed-status am-feed-status--${streamStatus.tone}`}>
          {'resolving' in live && live.resolving ? 'Resolving…' : streamStatus.label}
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
