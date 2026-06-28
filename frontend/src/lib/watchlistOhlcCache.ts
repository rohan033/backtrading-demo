import type { WatchlistSanitizedCandle } from './watchlistCandles'

export const WATCHLIST_OHLC_UPDATED_EVENT = 'watchlist-ohlc-updated'

const ohlcByTickKey: Record<string, WatchlistSanitizedCandle[]> = {}

export function getWatchlistOhlcCache(tickKey: string): WatchlistSanitizedCandle[] | undefined {
  const candles = ohlcByTickKey[tickKey]
  return candles?.length ? candles : undefined
}

export function setWatchlistOhlcCache(
  tickKey: string,
  candles: WatchlistSanitizedCandle[],
): void {
  if (!candles.length) return
  ohlcByTickKey[tickKey] = candles
  window.dispatchEvent(new CustomEvent(WATCHLIST_OHLC_UPDATED_EVENT, { detail: tickKey }))
}

export function hasWatchlistOhlcCache(tickKey: string): boolean {
  return (ohlcByTickKey[tickKey]?.length ?? 0) > 0
}
