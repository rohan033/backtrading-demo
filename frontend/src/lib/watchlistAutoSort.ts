import {
  WATCHLIST_CHANGE_WINDOWS,
  type WatchlistChangeWindowId,
} from './watchlistChangeColumns'
import { safeSetItem } from './safeStorage'
import type { WatchlistBroker } from './watchlistBrokers'
import { watchlistTickKey, type WatchlistSymbol } from './watchlists'

export const WATCHLIST_AUTO_SORT_STORAGE_KEY = 'watchlist-auto-sort-v1'

export type WatchlistAutoSortConfig = {
  enabled: boolean
  column: WatchlistChangeWindowId
}

export const DEFAULT_AUTO_SORT_CONFIG: WatchlistAutoSortConfig = {
  enabled: false,
  column: '1m',
}

export function loadWatchlistAutoSortConfig(): WatchlistAutoSortConfig {
  try {
    const raw = localStorage.getItem(WATCHLIST_AUTO_SORT_STORAGE_KEY)
    if (!raw) return DEFAULT_AUTO_SORT_CONFIG
    const parsed = JSON.parse(raw) as Partial<WatchlistAutoSortConfig>
    const allowed = new Set(WATCHLIST_CHANGE_WINDOWS.map(window => window.id))
    const column =
      typeof parsed.column === 'string' && allowed.has(parsed.column as WatchlistChangeWindowId)
        ? (parsed.column as WatchlistChangeWindowId)
        : DEFAULT_AUTO_SORT_CONFIG.column
    return {
      enabled: Boolean(parsed.enabled),
      column,
    }
  } catch {
    return DEFAULT_AUTO_SORT_CONFIG
  }
}

export function saveWatchlistAutoSortConfig(config: WatchlistAutoSortConfig): void {
  safeSetItem(WATCHLIST_AUTO_SORT_STORAGE_KEY, JSON.stringify(config))
}

export type WindowChangesLookup = Record<
  string,
  Partial<Record<WatchlistChangeWindowId, number | null>>
>

/** Sort symbols by a change column descending; symbols without data sink to the bottom. */
export function sortSymbolsByWindowChange(
  symbols: WatchlistSymbol[],
  broker: WatchlistBroker,
  accountEnv: string,
  windowChanges: WindowChangesLookup,
  columnId: WatchlistChangeWindowId,
): WatchlistSymbol[] {
  return [...symbols].sort((a, b) => {
    const keyA = watchlistTickKey(broker, accountEnv, a.symboltoken)
    const keyB = watchlistTickKey(broker, accountEnv, b.symboltoken)
    const valA = windowChanges[keyA]?.[columnId]
    const valB = windowChanges[keyB]?.[columnId]
    const numA = valA != null && Number.isFinite(valA) ? valA : Number.NEGATIVE_INFINITY
    const numB = valB != null && Number.isFinite(valB) ? valB : Number.NEGATIVE_INFINITY
    if (numB !== numA) return numB - numA
    return a.tradingsymbol.localeCompare(b.tradingsymbol)
  })
}
