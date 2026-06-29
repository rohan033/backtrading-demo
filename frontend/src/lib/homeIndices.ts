import {
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistBroker,
} from './watchlistBrokers'
import type { WatchlistSanitizedCandle } from './watchlistCandles'
import { watchlistTickKey } from './watchlists'
import type { LineData } from 'lightweight-charts'

export const HOME_INDEX_DEFINITIONS = [
  {
    id: 'spx500',
    query: 'SPX500',
    label: 'SPX500',
    shortLabel: 'S&P 500',
    color: '#2F80ED',
  },
  {
    id: 'nsdq100',
    query: 'NSDQ100',
    label: 'NSDQ100',
    shortLabel: 'NASDAQ 100',
    color: '#9B51E0',
  },
  {
    id: 'dj30',
    query: 'DJ30',
    label: 'DJ30',
    shortLabel: 'DJ30',
    color: '#F2994A',
  },
] as const

export type HomeIndexDefinition = (typeof HOME_INDEX_DEFINITIONS)[number]

export type HomeIndexSymbol = HomeIndexDefinition & {
  tradingsymbol: string
  symboltoken: string
  exchange: string
  tickKey: string
}

const resolvedCache = new Map<string, HomeIndexSymbol[]>()

function cacheKey(broker: WatchlistBroker, accountEnv: string): string {
  return `${broker}:${accountEnv}`
}

export async function resolveHomeIndices(
  broker: WatchlistBroker,
  accountEnv: string,
): Promise<HomeIndexSymbol[]> {
  const key = cacheKey(broker, accountEnv)
  const cached = resolvedCache.get(key)
  if (cached?.length) return cached

  const resolved = await Promise.all(
    HOME_INDEX_DEFINITIONS.map(async definition => {
      const hits = await searchWatchlistSymbol(broker, definition.query, accountEnv)
      const hit = pickWatchlistSymbolMatch(hits, definition.query)
      if (!hit) return null

      return {
        ...definition,
        tradingsymbol: hit.tradingsymbol,
        symboltoken: hit.symboltoken,
        exchange: hit.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE'),
        tickKey: watchlistTickKey(broker, accountEnv, hit.symboltoken),
      }
    }),
  )

  const symbols = resolved.filter((item): item is HomeIndexSymbol => item != null)
  if (symbols.length) resolvedCache.set(key, symbols)
  return symbols
}

export function indexPriceLine(candles: WatchlistSanitizedCandle[]): LineData[] {
  return [...candles]
    .filter(candle => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.time - b.time)
    .map(candle => ({
      time: candle.time as LineData['time'],
      value: candle.close,
    }))
}

export function formatIndexPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function latestIndexPrice(candles: WatchlistSanitizedCandle[]): number | null {
  const last = candles[candles.length - 1]
  return last && Number.isFinite(last.close) && last.close > 0 ? last.close : null
}

export function indexPriceAtTime(
  candles: WatchlistSanitizedCandle[],
  time: number,
): number | null {
  if (!candles.length) return null
  const bucket = Math.floor(time / 60) * 60
  const exact = candles.find(candle => candle.time === bucket)
  if (exact) return exact.close

  let nearest: WatchlistSanitizedCandle | null = null
  for (const candle of candles) {
    if (candle.time > bucket) break
    nearest = candle
  }
  return nearest?.close ?? null
}

export function formatIndexHoverTime(time: number): string {
  return new Date(time * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
