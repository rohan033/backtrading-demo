import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
} from 'lightweight-charts'

import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'
import { loadHomeChartHistory } from '@/lib/homeChartHistory'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'
import {
  candlesToVolumeData,
  mergeLiveTickIntoWatchlistCandles,
  mergePriceSamples,
  ohlcCandlesToPriceSamples,
  samplesToWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '@/lib/watchlistCandles'
import type { PriceSample } from '@/lib/watchlistChangeColumns'
import type { WatchlistChartSymbol } from '@/lib/watchlistUniqueSymbols'

type Props = {
  symbol: string
  token?: string | null
  exchange?: string
  broker: WatchlistBroker
  accountEnv?: 'live' | 'demo'
  height: number
}

function linePoints(samples: PriceSample[], liveLtp: number | null): LineData[] {
  const byTime = new Map<number, number>()
  for (const sample of samples) {
    if (!Number.isFinite(sample.ltp) || sample.ltp <= 0) continue
    byTime.set(Math.floor(sample.ts / 1000), sample.ltp)
  }
  if (liveLtp != null && Number.isFinite(liveLtp) && liveLtp > 0) {
    byTime.set(Math.floor(Date.now() / 1000), liveLtp)
  }
  return [...byTime.entries()]
    .sort(([a], [b]) => a - b)
    .map(([time, value]) => ({ time: time as LineData['time'], value }))
}

function sortedUniqueCandles(candles: WatchlistSanitizedCandle[]): WatchlistSanitizedCandle[] {
  const byTime = new Map<number, WatchlistSanitizedCandle>()
  for (const candle of candles) {
    if (!Number.isFinite(candle.time)) continue
    byTime.set(candle.time, candle)
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

export default function SessionDetailChart({
  symbol,
  token,
  exchange,
  broker,
  accountEnv,
  height,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const lineRef = useRef<ISeriesApi<'Line'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const userInteractedRef = useRef(false)
  const lastAutoFitKeyRef = useRef<string | null>(null)
  const [candles, setCandles] = useState<WatchlistSanitizedCandle[]>([])
  const [loading, setLoading] = useState(false)

  const env = accountEnv || defaultAccountEnv(broker)
  const live = useCandidateChartLive({
    symbol,
    token,
    exchange,
    broker,
    accountEnv: env,
    enabled: Boolean(symbol),
  })

  const candleData = useMemo(() => {
    return sortedUniqueCandles(
      mergeLiveTickIntoWatchlistCandles(candles, live.ltp),
    )
  }, [candles, live.ltp])

  const lineData = useMemo(() => {
    if (candleData.length) {
      const merged = mergePriceSamples(
        ohlcCandlesToPriceSamples(candleData),
        live.samples,
      )
      return linePoints(merged, live.ltp)
    }
    return linePoints(live.samples, live.ltp)
  }, [candleData, live.ltp, live.samples])

  const lineVolumeData = useMemo(() => {
    const source = candleData.length
      ? candleData
      : mergeLiveTickIntoWatchlistCandles(samplesToWatchlistCandles(live.samples), live.ltp)
    return candlesToVolumeData(sortedUniqueCandles(source))
  }, [candleData, live.ltp, live.samples])

  const hasVolume = lineVolumeData.some(item => Number(item.value) > 0)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    userInteractedRef.current = false
    lastAutoFitKeyRef.current = null
    const chart = createChart(el, {
      width: Math.max(1, el.clientWidth),
      height: Math.max(80, height),
      attributionLogo: false,
      layout: { background: { color: '#FFFFFF' }, textColor: '#9A9A9A' },
      grid: {
        vertLines: { color: '#F1F1F1' },
        horzLines: { color: '#F1F1F1' },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.24 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart
    lineRef.current = null
    volumeRef.current = null
    const resize = () => chart.applyOptions({ width: Math.max(1, el.clientWidth), height: Math.max(80, height) })
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
      lineRef.current = null
      volumeRef.current = null
    }
  }, [height, live.tickKey])

  useEffect(() => {
    let cancelled = false
    setCandles([])
    setLoading(true)

    if (!symbol.trim()) {
      setLoading(false)
      return undefined
    }
    if (broker === 'etoro' && !live.feedToken && live.resolving) {
      return undefined
    }

    const instrumentToken = live.feedToken || (broker === 'angel' ? symbol : null)
    if (!instrumentToken) {
      setLoading(false)
      return undefined
    }

    const chartSymbol: WatchlistChartSymbol = {
      tickKey: live.tickKey,
      watchlistId: 'session-detail',
      broker,
      accountEnv: env,
      tradingsymbol: symbol,
      symboltoken: String(instrumentToken),
      exchange: live.resolvedExchange || exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
    }

    void loadHomeChartHistory(chartSymbol, {
      onRefresh: fresh => {
        if (cancelled || !fresh.length) return
        setCandles(sortedUniqueCandles(fresh))
      },
    })
      .then(next => {
        if (cancelled) return
        setCandles(sortedUniqueCandles(next))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [
    broker,
    env,
    exchange,
    live.feedToken,
    live.resolvedExchange,
    live.resolving,
    live.tickKey,
    symbol,
  ])

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (!lineRef.current) {
      lineRef.current = chart.addLineSeries({
        color: '#2F80ED',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      volumeRef.current = chart.addHistogramSeries({
        priceFormat: { type: 'volume' },
        priceScaleId: 'volume',
      })
      chart.priceScale('volume').applyOptions({
        scaleMargins: { top: 0.78, bottom: 0 },
      })
    }
    lineRef.current.setData(lineData)
    volumeRef.current?.setData(hasVolume ? lineVolumeData : [])
    const autoFitKey = `${live.tickKey}:${lineData.length}`
    if (lineData.length && !userInteractedRef.current && lastAutoFitKeyRef.current !== autoFitKey) {
      chart.timeScale().fitContent()
      lastAutoFitKeyRef.current = autoFitKey
    }
  }, [hasVolume, lineData, lineVolumeData, live.tickKey])

  return (
    <div className="wt-mini-chart">
      <div ref={hostRef} className="wt-mini-chart-host" />
      {!lineData.length ? <span className="wt-chart-label">waiting for live price</span> : null}
      {lineData.length > 0 && !hasVolume ? <span className="wt-volume-note">volume unavailable</span> : null}
      {loading && !candleData.length ? <span className="wt-chart-label">loading chart…</span> : null}
    </div>
  )
}
