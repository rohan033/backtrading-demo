import { defaultAccountEnv, type WatchlistBroker } from './watchlistBrokers'
import {
  addWatchlistSymbol,
  createWatchlist,
  deleteWatchlist,
  removeWatchlistSymbol,
  updateWatchlist,
  type Watchlist,
  type WatchlistSymbol,
} from './watchlists'
import { saveSymbolOrder } from './watchlistMomentumState'

export const MAX_WATCHLIST_STOCKS = 5

export type ReorganizeWatchlistChunk = {
  broker: WatchlistBroker
  accountEnv: string
  symbols: WatchlistSymbol[]
}

/** Flatten panel watchlists in order, then split into chunks of at most `maxPerWatchlist`. */
export function planPanelWatchlistChunks(
  watchlists: Watchlist[],
  getSymbols: (watchlist: Watchlist) => WatchlistSymbol[],
  maxPerWatchlist = MAX_WATCHLIST_STOCKS,
): ReorganizeWatchlistChunk[] {
  const sorted = [...watchlists].sort((a, b) => a.position - b.position)
  const chunks: ReorganizeWatchlistChunk[] = []

  for (const watchlist of sorted) {
    const broker = (watchlist.broker || 'angel') as WatchlistBroker
    const accountEnv = watchlist.account_env || defaultAccountEnv(broker)

    for (const symbol of getSymbols(watchlist)) {
      const last = chunks[chunks.length - 1]
      if (
        last
        && last.broker === broker
        && last.accountEnv === accountEnv
        && last.symbols.length < maxPerWatchlist
      ) {
        last.symbols.push(symbol)
      } else {
        chunks.push({ broker, accountEnv, symbols: [symbol] })
      }
    }
  }

  return chunks
}

export function panelNeedsReorganize(
  watchlists: Watchlist[],
  getSymbols: (watchlist: Watchlist) => WatchlistSymbol[],
  maxPerWatchlist = MAX_WATCHLIST_STOCKS,
): boolean {
  if (watchlists.some(watchlist => getSymbols(watchlist).length > maxPerWatchlist)) {
    return true
  }

  const planned = planPanelWatchlistChunks(watchlists, getSymbols, maxPerWatchlist)
  if (planned.length !== watchlists.length) return true

  const sorted = [...watchlists].sort((a, b) => a.position - b.position)
  return planned.some((chunk, index) => {
    const current = sorted[index]
    if (!current) return true
    const broker = (current.broker || 'angel') as WatchlistBroker
    const accountEnv = current.account_env || defaultAccountEnv(broker)
    if (broker !== chunk.broker || accountEnv !== chunk.accountEnv) return true
    const currentTokens = getSymbols(current).map(symbol => symbol.symboltoken)
    const plannedTokens = chunk.symbols.map(symbol => symbol.symboltoken)
    return currentTokens.join('\0') !== plannedTokens.join('\0')
  })
}

export async function applyPanelWatchlistReorganize(
  panelId: string,
  watchlists: Watchlist[],
  chunks: ReorganizeWatchlistChunk[],
): Promise<Watchlist[]> {
  const sorted = [...watchlists].sort((a, b) => a.position - b.position)
  const targets: Watchlist[] = []

  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    const name = `Watchlist ${index + 1}`

    if (index < sorted.length) {
      targets.push(
        await updateWatchlist(sorted[index].id, {
          name,
          broker: chunk.broker,
          account_env: chunk.accountEnv,
          panel_id: panelId,
        }),
      )
      continue
    }

    targets.push(
      await createWatchlist(name, {
        broker: chunk.broker,
        account_env: chunk.accountEnv,
        panel_id: panelId,
      }),
    )
  }

  // Clear every symbol from original panel watchlists before re-assigning.
  for (const watchlist of sorted) {
    for (const symbol of [...watchlist.symbols]) {
      await removeWatchlistSymbol(watchlist.id, symbol.symboltoken)
    }
  }

  const results: Watchlist[] = []
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index]
    let watchlist = targets[index]
    for (const symbol of chunk.symbols) {
      watchlist = await addWatchlistSymbol(watchlist.id, {
        symboltoken: symbol.symboltoken,
        tradingsymbol: symbol.tradingsymbol,
        exchange: symbol.exchange,
      })
    }
    saveSymbolOrder(
      watchlist.id,
      chunk.symbols.map(symbol => symbol.symboltoken),
    )
    results.push(watchlist)
  }

  for (let index = chunks.length; index < sorted.length; index++) {
    await deleteWatchlist(sorted[index].id)
  }

  return results
}
