import { useCallback, useEffect, useRef, useState } from 'react'

import { defaultAccountEnv } from '../lib/watchlistBrokers'
import { searchWatchlistSymbol, pickWatchlistSymbolMatch } from '../lib/watchlistBrokers'
import {
  fetchWatchlistSymbolCandles,
  type WatchlistSanitizedCandle,
} from '../lib/watchlistCandles'

const TOKEN_CACHE = new Map<string, { token: string; at: number }>()
const TOKEN_TTL_MS = 10 * 60_000
const CANDLE_TTL_MS = 45_000
const CONCURRENCY = 4

/** Survives React unmount — tab switches reuse cached candles without refetching. */
const OVERVIEW_CANDLE_CACHE = new Map<string, { candles: WatchlistSanitizedCandle[]; at: number }>()

function overviewCacheKey(symbol: string, accountEnv: string): string {
  return `${accountEnv}:${symbol.toUpperCase()}`
}

function readCachedSymbols(
  symbols: string[],
  accountEnv: string,
): Record<string, WatchlistSanitizedCandle[]> {
  const out: Record<string, WatchlistSanitizedCandle[]> = {}
  const now = Date.now()
  for (const symbol of symbols) {
    const key = overviewCacheKey(symbol, accountEnv)
    const entry = OVERVIEW_CANDLE_CACHE.get(key)
    if (!entry || now - entry.at > CANDLE_TTL_MS) continue
    if (entry.candles.length) out[symbol] = entry.candles
  }
  return out
}

async function resolveToken(symbol: string, accountEnv: string): Promise<string | null> {
  const key = `${accountEnv}:${symbol.toUpperCase()}`
  const cached = TOKEN_CACHE.get(key)
  if (cached && Date.now() - cached.at < TOKEN_TTL_MS) return cached.token

  const hits = await searchWatchlistSymbol('etoro', symbol, accountEnv)
  const match = pickWatchlistSymbolMatch(hits, symbol)
  const token = match?.symboltoken?.trim()
  if (!token) return null
  TOKEN_CACHE.set(key, { token, at: Date.now() })
  return token
}

async function fetchSymbolCandles(
  symbol: string,
  accountEnv: string,
): Promise<WatchlistSanitizedCandle[]> {
  const token = await resolveToken(symbol, accountEnv)
  if (!token) return []
  return fetchWatchlistSymbolCandles({
    broker: 'etoro',
    accountEnv,
    tradingsymbol: symbol,
    symboltoken: token,
  }, 60)
}

export function useOverviewCandleCache(
  symbols: string[],
  accountEnv: string,
  enabled: boolean,
) {
  const uniqueSymbols = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))]
  const [candlesBySymbol, setCandlesBySymbol] = useState<Record<string, WatchlistSanitizedCandle[]>>(
    () => (enabled ? readCachedSymbols(uniqueSymbols, accountEnv) : {}),
  )
  const [loading, setLoading] = useState(false)
  const inFlightRef = useRef(false)

  useEffect(() => {
    if (!enabled) return
    const cached = readCachedSymbols(uniqueSymbols, accountEnv)
    if (!Object.keys(cached).length) return
    setCandlesBySymbol(prev => ({ ...cached, ...prev }))
  }, [enabled, accountEnv, uniqueSymbols.join('|')])

  const refresh = useCallback(async () => {
    if (!enabled || !uniqueSymbols.length || inFlightRef.current) return

    const stale = uniqueSymbols.filter(symbol => {
      const entry = OVERVIEW_CANDLE_CACHE.get(overviewCacheKey(symbol, accountEnv))
      return !entry || Date.now() - entry.at > CANDLE_TTL_MS
    })
    if (!stale.length) return

    inFlightRef.current = true
    setLoading(true)
    try {
      const next: Record<string, WatchlistSanitizedCandle[]> = {}
      for (let i = 0; i < stale.length; i += CONCURRENCY) {
        const batch = stale.slice(i, i + CONCURRENCY)
        const results = await Promise.all(
          batch.map(async symbol => {
            try {
              const candles = await fetchSymbolCandles(symbol, accountEnv)
              OVERVIEW_CANDLE_CACHE.set(overviewCacheKey(symbol, accountEnv), {
                candles,
                at: Date.now(),
              })
              return [symbol, candles] as const
            } catch {
              return [symbol, []] as const
            }
          }),
        )
        for (const [symbol, candles] of results) {
          next[symbol] = candles
        }
      }
      setCandlesBySymbol(prev => ({ ...prev, ...next }))
    } finally {
      inFlightRef.current = false
      setLoading(false)
    }
  }, [uniqueSymbols, accountEnv, enabled])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!enabled) return
    const id = window.setInterval(() => { void refresh() }, CANDLE_TTL_MS)
    return () => window.clearInterval(id)
  }, [enabled, refresh])

  return { candlesBySymbol, loading, refresh }
}

export function defaultOverviewAccountEnv(): 'live' | 'demo' {
  return defaultAccountEnv('etoro')
}
