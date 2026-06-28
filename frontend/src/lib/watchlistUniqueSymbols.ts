import { defaultAccountEnv, type WatchlistBroker } from './watchlistBrokers'
import { watchlistTickKey, type Watchlist, type WatchlistSymbol } from './watchlists'

export type WatchlistChartSymbol = {
  tickKey: string
  watchlistId: string
  broker: WatchlistBroker
  accountEnv: string
  symboltoken: string
  tradingsymbol: string
  exchange: string
}

/** Unique symbols across watchlists (deduped by live tick key). */
export function uniqueWatchlistChartSymbols(
  watchlists: Watchlist[],
  visibleSymbolsFor: (wl: Watchlist) => WatchlistSymbol[],
): WatchlistChartSymbol[] {
  const seen = new Set<string>()
  const result: WatchlistChartSymbol[] = []

  for (const watchlist of watchlists) {
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)
    for (const symbol of visibleSymbolsFor(watchlist)) {
      const tickKey = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
      if (seen.has(tickKey)) continue
      seen.add(tickKey)
      result.push({
        tickKey,
        watchlistId: watchlist.id,
        broker,
        accountEnv,
        symboltoken: symbol.symboltoken,
        tradingsymbol: symbol.tradingsymbol,
        exchange: symbol.exchange,
      })
    }
  }

  return result.sort((a, b) => a.tradingsymbol.localeCompare(b.tradingsymbol))
}
