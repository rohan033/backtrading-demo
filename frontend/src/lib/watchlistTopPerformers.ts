import type { WindowChangesLookup } from './watchlistAutoSort'
import type { WatchlistChangeWindowId } from './watchlistChangeColumns'
import {
  applySymbolOrder,
  loadSymbolOrder,
  momentumSymbolKey,
} from './watchlistMomentumState'
import { watchlistTickKey, type Watchlist, type WatchlistSymbol } from './watchlists'

export type RankedWatchlistSymbol = {
  watchlistId: string
  watchlistName: string
  symbol: WatchlistSymbol
  tickKey: string
  change: number | null
  momentumNormal: boolean
  momentumNoTp: boolean
  momentumLive: boolean
}

export type MomentumLookup = {
  watchlistIds: Set<string>
  symbolKeys: Set<string>
  noTpSymbolKeys: Set<string>
  liveSymbolKeys: Set<string>
}

function momentumFlags(
  watchlist: Watchlist,
  symbol: WatchlistSymbol,
  isFirst: boolean,
  momentum: MomentumLookup,
): Pick<RankedWatchlistSymbol, 'momentumNormal' | 'momentumNoTp' | 'momentumLive'> {
  const key = momentumSymbolKey(watchlist.id, symbol.symboltoken)
  const momentumNormal =
    momentum.symbolKeys.has(key)
    || (momentum.watchlistIds.has(watchlist.id) && isFirst)
  return {
    momentumNormal,
    momentumNoTp: momentum.noTpSymbolKeys.has(key),
    momentumLive: momentum.liveSymbolKeys.has(key),
  }
}

/** Flatten all watchlist symbols and return top performers by % change (desc). */
export function getTopWatchlistPerformers(
  watchlists: Watchlist[],
  windowChanges: WindowChangesLookup,
  columnId: WatchlistChangeWindowId,
  momentum: MomentumLookup,
  limit = 5,
  excludeSymbolKeys: Set<string> = new Set(),
): RankedWatchlistSymbol[] {
  const rows: RankedWatchlistSymbol[] = []

  for (const watchlist of watchlists) {
    if (!watchlist.symbols.length) continue
    const ordered = applySymbolOrder(watchlist.symbols, loadSymbolOrder(watchlist.id))
    const accountEnv = watchlist.account_env || (watchlist.broker === 'etoro' ? 'demo' : 'live')

    ordered.forEach((symbol, index) => {
      const symKey = momentumSymbolKey(watchlist.id, symbol.symboltoken)
      if (excludeSymbolKeys.has(symKey)) return

      const tickKey = watchlistTickKey(watchlist.broker, accountEnv, symbol.symboltoken)
      const flags = momentumFlags(watchlist, symbol, index === 0, momentum)
      rows.push({
        watchlistId: watchlist.id,
        watchlistName: watchlist.name,
        symbol,
        tickKey,
        change: windowChanges[tickKey]?.[columnId] ?? null,
        ...flags,
      })
    })
  }

  rows.sort((a, b) => {
    const numA = a.change != null && Number.isFinite(a.change) ? a.change : Number.NEGATIVE_INFINITY
    const numB = b.change != null && Number.isFinite(b.change) ? b.change : Number.NEGATIVE_INFINITY
    if (numB !== numA) return numB - numA
    return a.symbol.tradingsymbol.localeCompare(b.symbol.tradingsymbol)
  })

  return rows.slice(0, limit)
}
