import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchWatchlistSymbolCandles,
  mergeLiveTailSamples,
  mergeLiveTickIntoWatchlistCandles,
  samplesToWatchlistCandles,
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
  const [ohlcRevision, setOhlcRevision] = useState(0)
  const symbolsRef = useRef(symbols)
  const loadingKeysRef = useRef<Set<string>>(new Set())

  symbolsRef.current = symbols

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
      const candles = await fetchWatchlistSymbolCandles(symbol)
      if (candles.length) {
        setWatchlistOhlcCache(tickKey, candles)
        setHistoricalByKey(prev => ({ ...prev, [tickKey]: candles }))
      }
    } finally {
      loadingKeysRef.current.delete(tickKey)
      setLoadingTickKey(current => (current === tickKey ? null : current))
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
    [focusedTickKey, historicalByKey],
  )

  return {
    candlesByKey,
    loadHistoricalCandles,
    loadingTickKey,
    hasHistorical,
  }
}
