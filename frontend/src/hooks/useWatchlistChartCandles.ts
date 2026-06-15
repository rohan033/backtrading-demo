import { useEffect, useMemo, useRef, useState } from 'react'

import {
  fetchWatchlistSymbolCandles,
  mergeLiveTickIntoWatchlistCandles,
  samplesToWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '../lib/watchlistCandles'
import type { PriceSample } from '../lib/watchlistChangeColumns'
import type { WatchlistChartSymbol } from '../lib/watchlistUniqueSymbols'
import type { WatchlistTick } from '../lib/watchlists'

const MAX_CONCURRENT = 3

export function useWatchlistChartCandles(
  symbols: WatchlistChartSymbol[],
  ticks: Record<string, WatchlistTick>,
  samplesByKey: Record<string, PriceSample[]>,
  enabled: boolean,
) {
  const [candlesByKey, setCandlesByKey] = useState<Record<string, WatchlistSanitizedCandle[]>>({})
  const fetchedRef = useRef<Set<string>>(new Set())
  const inflightRef = useRef<Set<string>>(new Set())
  const symbolsRef = useRef(symbols)
  const samplesByKeyRef = useRef(samplesByKey)

  useEffect(() => {
    symbolsRef.current = symbols
  }, [symbols])

  useEffect(() => {
    samplesByKeyRef.current = samplesByKey
  }, [samplesByKey])

  const symbolsKey = useMemo(
    () => symbols.map(symbol => symbol.tickKey).sort().join('|'),
    [symbols],
  )

  useEffect(() => {
    if (!enabled || symbols.length === 0) return undefined

    let cancelled = false
    let cursor = 0
    const jobs = symbolsRef.current

    const worker = async () => {
      while (cursor < jobs.length) {
        if (cancelled) return
        const symbol = jobs[cursor++]
        if (fetchedRef.current.has(symbol.tickKey) || inflightRef.current.has(symbol.tickKey)) continue

        inflightRef.current.add(symbol.tickKey)
        try {
          const candles = await fetchWatchlistSymbolCandles(symbol)
          if (cancelled) return
          fetchedRef.current.add(symbol.tickKey)
          setCandlesByKey(prev => ({
            ...prev,
            [symbol.tickKey]: candles.length
              ? candles
              : samplesToWatchlistCandles(samplesByKeyRef.current[symbol.tickKey] ?? []),
          }))
        } catch {
          fetchedRef.current.add(symbol.tickKey)
          setCandlesByKey(prev => ({
            ...prev,
            [symbol.tickKey]: samplesToWatchlistCandles(samplesByKeyRef.current[symbol.tickKey] ?? []),
          }))
        } finally {
          inflightRef.current.delete(symbol.tickKey)
        }
      }
    }

    void Promise.all(Array.from({ length: MAX_CONCURRENT }, () => worker()))

    return () => {
      cancelled = true
    }
  }, [enabled, symbolsKey, symbols.length])

  return useMemo(() => {
    const result: Record<string, WatchlistSanitizedCandle[]> = {}
    for (const symbol of symbols) {
      const apiCandles = candlesByKey[symbol.tickKey]
      const fallback = samplesToWatchlistCandles(samplesByKey[symbol.tickKey] ?? [])
      const base = apiCandles?.length ? apiCandles : fallback
      result[symbol.tickKey] = mergeLiveTickIntoWatchlistCandles(base, ticks[symbol.tickKey]?.ltp)
    }
    return result
  }, [symbols, candlesByKey, samplesByKey, ticks])
}
