import { useEffect, useMemo, useRef, useState } from 'react'
import { createChart, type IChartApi, type ISeriesApi, type LineData } from 'lightweight-charts'

import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'
import type { CandidateLiveFeed } from '@/hooks/useMultiSymbolLiveFeeds'
import { mergeHistoryWithLiveTail } from '@/lib/agentChartLiveLine'
import { loadHomeChartHistory } from '@/lib/homeChartHistory'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import type { WatchlistSanitizedCandle } from '@/lib/watchlistCandles'
import type { WatchlistChartSymbol } from '@/lib/watchlistUniqueSymbols'

type Props = {
  symbol: string
  token?: string | null
  exchange?: string
  broker?: WatchlistBroker
  accountEnv?: 'live' | 'demo'
  height?: number
  /** Shared feed from workspace — avoids duplicate WebSockets per symbol */
  liveFeed?: CandidateLiveFeed | null
}

export default function AgentCandidateMiniChart({
  symbol,
  token,
  exchange,
  broker = 'etoro',
  accountEnv,
  height = 96,
  liveFeed = null,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const lastPointRef = useRef<LineData | null>(null)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [error, setError] = useState('')
  const [tickFlash, setTickFlash] = useState(false)

  const env = accountEnv || defaultAccountEnv(broker)
  const internalLive = useCandidateChartLive({
    symbol,
    token,
    exchange,
    broker,
    accountEnv: env,
    enabled: !liveFeed,
  })

  const live = liveFeed ?? {
    tickKey: internalLive.tickKey,
    feedToken: internalLive.feedToken,
    resolvedExchange: internalLive.resolvedExchange,
    ltp: internalLive.ltp,
    streamStatus: internalLive.streamStatus,
    samples: internalLive.samples,
    resolving: internalLive.resolving,
  }

  useEffect(() => {
    let cancelled = false
    if (!symbol.trim()) return undefined
    if (broker === 'etoro' && !live.feedToken && live.resolving) return undefined
    if (broker === 'etoro' && !live.feedToken) return undefined

    const instrumentToken = live.feedToken || (broker === 'angel' ? symbol : null)
    if (!instrumentToken) return undefined

    const chartSymbol: WatchlistChartSymbol = {
      tickKey: live.tickKey,
      watchlistId: 'agent-candidate',
      broker,
      accountEnv: env,
      tradingsymbol: symbol,
      symboltoken: String(instrumentToken),
      exchange: live.resolvedExchange || exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
    }

    void loadHomeChartHistory(chartSymbol, { force: !candles.length })
      .then(rows => {
        if (!cancelled && rows.length) {
          setCandles(rows)
          setError('')
        }
      })
      .catch(() => {
        if (!cancelled) setError('Chart unavailable')
      })

    return () => {
      cancelled = true
    }
  }, [broker, candles.length, env, exchange, live.feedToken, live.resolving, live.resolvedExchange, live.tickKey, symbol])

  const lineData = useMemo(
    () => mergeHistoryWithLiveTail(candles, live.samples, live.ltp),
    [candles, live.ltp, live.samples],
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const chart = createChart(host, {
      width: host.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: '#5a6a7a' },
      grid: { vertLines: { visible: false }, horzLines: { color: '#e8eef4' } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: false, timeVisible: true },
      handleScroll: false,
      handleScale: false,
    })
    const series = chart.addLineSeries({
      color: '#4a7eb8',
      lineWidth: 2,
      priceLineVisible: true,
      lastValueVisible: true,
    })

    chartRef.current = chart
    seriesRef.current = series
    lastPointRef.current = null

    const ro = new ResizeObserver(() => {
      if (hostRef.current) chart.applyOptions({ width: hostRef.current.clientWidth })
    })
    ro.observe(host)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      lastPointRef.current = null
    }
  }, [height, live.tickKey])

  useEffect(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    if (!series) return

    if (!lineData.length) {
      if (!candles.length && live.ltp == null) {
        series.setData([])
        lastPointRef.current = null
      }
      return
    }

    const lastPoint = lineData[lineData.length - 1]
    const previous = lastPointRef.current
    const incremental = previous
      && (previous.time === lastPoint.time
        || (lastPoint.time > previous.time
          && lineData[lineData.length - 2]?.time === previous.time))

    if (incremental) {
      series.update(lastPoint)
      chart?.timeScale().scrollToRealTime()
    } else {
      series.setData(lineData)
      chart?.timeScale().fitContent()
    }
    lastPointRef.current = lastPoint
    setError('')
  }, [candles.length, lineData, live.ltp])

  useEffect(() => {
    if (live.ltp == null) return undefined
    setTickFlash(true)
    const id = window.setTimeout(() => setTickFlash(false), 450)
    return () => window.clearTimeout(id)
  }, [live.ltp, live.samples.length])

  const showError = error && !lineData.length && live.ltp == null && !live.resolving

  return (
    <div className="am-candidate-chart">
      <div className={`am-candidate-chart__live${tickFlash ? ' am-candidate-chart__live--flash' : ''}`}>
        <span className="am-candidate-chart__ltp">
          {live.ltp != null ? live.ltp.toFixed(2) : '—'}
        </span>
        <span className={`am-candidate-chart__feed am-candidate-chart__feed--${live.streamStatus.tone}`}>
          {live.resolving ? 'Resolving…' : live.streamStatus.label}
        </span>
      </div>
      {showError ? <div className="am-candidate-chart__empty">{error}</div> : null}
      <div ref={hostRef} className="am-candidate-chart__host" style={{ height }} />
    </div>
  )
}
