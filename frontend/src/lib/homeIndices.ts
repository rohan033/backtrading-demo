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

/** Percent change from the first bar so indices share one comparable scale. */
export function indexPercentLine(candles: WatchlistSanitizedCandle[]): LineData[] {
  const sorted = [...candles].sort((a, b) => a.time - b.time)
  const base = sorted.find(candle => Number.isFinite(candle.close) && candle.close > 0)?.close
  if (!base) return []

  return sorted
    .filter(candle => Number.isFinite(candle.close) && candle.close > 0)
    .map(candle => ({
      time: candle.time as LineData['time'],
      value: ((candle.close / base) - 1) * 100,
    }))
}

export function formatIndexChangePct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function latestIndexChange(line: LineData[]): number | null {
  const last = line[line.length - 1]
  return last && Number.isFinite(last.value) ? last.value : null
}
