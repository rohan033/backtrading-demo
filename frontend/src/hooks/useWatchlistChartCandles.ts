import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchWatchlistOlderCandles,
  fetchWatchlistSymbolCandles,
  mergeLiveTailSamples,
  mergeLiveTickIntoWatchlistCandles,
  mergeWatchlistCandleHistory,
  samplesToWatchlistCandles,
  WATCHLIST_CHART_INITIAL_COUNT,
  type WatchlistSanitizedCandle,
} from '../lib/watchlistCandles'
import {
  getWatchlistOhlcCache,
  hasWatchlistOhlcCache,
  setWatchlistOhlcCache,
  WATCHLIST_OHLC_UPDATED_EVENT,
} from '../lib/watchlistOhlcCache'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import type { WatchlistChartSymbol } from '../lib/watchlistUniqueSymbols'
import type { WatchlistTick } from '../lib/watchlists'

function resolveHistoricalCandles(
  tickKey: string,
  focusedTickKey: string | null,
  historicalByKey: Record<string, WatchlistSanitizedCandle[]>,
): WatchlistSanitizedCandle[] | undefined {
  if (!focusedTickKey || tickKey !== focusedTickKey) return undefined
  const loaded = historicalByKey[tickKey]
  if (loaded?.length) return loaded
  return getWatchlistOhlcCache(tickKey)
}

export function useWatchlistChartCandles(
  symbols: WatchlistChartSymbol[],
  ticks: Record<string, WatchlistTick>,
  samplesByKey: Record<string, PriceSample[]>,
  focusedTickKey: string | null,
) {
  const [historicalByKey, setHistoricalByKey] = useState<
    Record<string, WatchlistSanitizedCandle[]>
  >({})
  const [loadingTickKey, setLoadingTickKey] = useState<string | null>(null)
  const [loadingOlderTickKey, setLoadingOlderTickKey] = useState<string | null>(null)
  const [ohlcRevision, setOhlcRevision] = useState(0)
  const symbolsRef = useRef(symbols)
  const historicalByKeyRef = useRef(historicalByKey)
  const loadingKeysRef = useRef<Set<string>>(new Set())
  const loadingOlderKeysRef = useRef<Set<string>>(new Set())

  symbolsRef.current = symbols
  historicalByKeyRef.current = historicalByKey

  useEffect(() => {
    const onOhlcUpdated = () => setOhlcRevision(revision => revision + 1)
    window.addEventListener(WATCHLIST_OHLC_UPDATED_EVENT, onOhlcUpdated)
    return () => window.removeEventListener(WATCHLIST_OHLC_UPDATED_EVENT, onOhlcUpdated)
  }, [])

  const loadHistoricalCandles = useCallback(async (tickKey: string, force = false) => {
    if (loadingKeysRef.current.has(tickKey)) return

    if (!force) {
      const cached = getWatchlistOhlcCache(tickKey)
      if (cached?.length) {
        setHistoricalByKey(prev => {
          if (prev[tickKey]?.length) return prev
          return { ...prev, [tickKey]: cached }
        })
        return
      }
    }

    const symbol = symbolsRef.current.find(item => item.tickKey === tickKey)
    if (!symbol) return

    loadingKeysRef.current.add(tickKey)
    setLoadingTickKey(tickKey)
    try {
      const candles = await fetchWatchlistSymbolCandles(symbol, WATCHLIST_CHART_INITIAL_COUNT)
      if (candles.length) {
        setWatchlistOhlcCache(tickKey, candles)
        setHistoricalByKey(prev => ({ ...prev, [tickKey]: candles }))
      }
    } finally {
      loadingKeysRef.current.delete(tickKey)
      setLoadingTickKey(current => (current === tickKey ? null : current))
    }
  }, [])

  const loadOlderHistoricalCandles = useCallback(async (
    tickKey: string,
  ): Promise<{ loadedCount: number; interval?: string }> => {
    if (loadingOlderKeysRef.current.has(tickKey) || loadingKeysRef.current.has(tickKey)) {
      return { loadedCount: 0 }
    }

    const symbol = symbolsRef.current.find(item => item.tickKey === tickKey)
    if (!symbol) return { loadedCount: 0 }

    const current = resolveHistoricalCandles(
      tickKey,
      tickKey,
      historicalByKeyRef.current,
    ) ?? getWatchlistOhlcCache(tickKey)
    if (!current?.length) return { loadedCount: 0 }

    loadingOlderKeysRef.current.add(tickKey)
    setLoadingOlderTickKey(tickKey)
    try {
      const { candles: older, loadedCount, interval } = await fetchWatchlistOlderCandles(
        symbol,
        current[0].time,
      )
      if (!loadedCount || !older.length) return { loadedCount: 0, interval }

      const merged = mergeWatchlistCandleHistory(older, current)
      setWatchlistOhlcCache(tickKey, merged)
      setHistoricalByKey(prev => ({ ...prev, [tickKey]: merged }))
      return { loadedCount, interval }
    } finally {
      loadingOlderKeysRef.current.delete(tickKey)
      setLoadingOlderTickKey(current => (current === tickKey ? null : current))
    }
  }, [])

  const candlesByKey = useMemo(() => {
    const result: Record<string, WatchlistSanitizedCandle[]> = {}
    for (const symbol of symbols) {
      const samples = samplesByKey[symbol.tickKey] ?? []
      const ltp = ticks[symbol.tickKey]?.ltp
      const historical = resolveHistoricalCandles(
        symbol.tickKey,
        focusedTickKey,
        historicalByKey,
      )

      if (historical?.length) {
        const withLiveTail = mergeLiveTailSamples(historical, samples)
        result[symbol.tickKey] = mergeLiveTickIntoWatchlistCandles(withLiveTail, ltp)
      } else {
        result[symbol.tickKey] = mergeLiveTickIntoWatchlistCandles(
          samplesToWatchlistCandles(samples),
          ltp,
        )
      }
    }
    return result
  }, [symbols, focusedTickKey, historicalByKey, samplesByKey, ticks, ohlcRevision])

  const hasHistorical = useCallback(
    (tickKey: string) =>
      tickKey === focusedTickKey
      && ((historicalByKey[tickKey]?.length ?? 0) > 0 || hasWatchlistOhlcCache(tickKey)),
    [focusedTickKey, historicalByKey, ohlcRevision],
  )

  return {
    candlesByKey,
    historicalByKey,
    loadHistoricalCandles,
    loadOlderHistoricalCandles,
    loadingTickKey,
    loadingOlderTickKey,
    hasHistorical,
  }
}
