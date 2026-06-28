import { defaultAccountEnv, type WatchlistBroker } from './watchlistBrokers'
import { watchlistTickKey, type Watchlist } from './watchlists'

export function tradingSymbolForTickKey(
  tickKey: string,
  watchlists: Watchlist[],
): string | null {
  for (const wl of watchlists) {
    const broker = (wl.broker || 'angel') as WatchlistBroker
    const accountEnv = wl.account_env || defaultAccountEnv(broker)
    for (const sym of wl.symbols) {
      if (watchlistTickKey(broker, accountEnv, sym.symboltoken) === tickKey) {
        return sym.tradingsymbol
      }
    }
  }
  return null
}
