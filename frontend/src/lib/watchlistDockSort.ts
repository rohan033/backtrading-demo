import type { WindowChangesLookup } from './watchlistAutoSort'
import type { WatchlistChangeWindowId } from './watchlistChangeColumns'
import { watchlistTickKey, type WatchlistSymbol } from './watchlists'

export const WATCHLIST_DOCK_SORT_STORAGE_KEY = 'watchlist-dock-sort-v2'
export const WATCHLIST_DOCK_COLLAPSED_STORAGE_KEY = 'watchlist-dock-collapsed-v1'

/** Change columns shown (and sortable) in the dock. */
export const DOCK_CHANGE_COLUMNS: WatchlistChangeWindowId[] = ['1m', '2m', '5m']

export type DockSortDir = 'asc' | 'desc'

export type DockSort = {
  column: WatchlistChangeWindowId
  dir: DockSortDir
} | null

/**
 * Cycles a column header through desc → asc → off. Clicking a different column
 * starts fresh at desc (top movers first).
 */
export function nextDockSort(current: DockSort, column: WatchlistChangeWindowId): DockSort {
  if (!current || current.column !== column) return { column, dir: 'desc' }
  if (current.dir === 'desc') return { column, dir: 'asc' }
  return null
}

export function loadWatchlistDockSort(): DockSort {
  try {
    const raw = localStorage.getItem(WATCHLIST_DOCK_SORT_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DockSort
    if (
      parsed &&
      DOCK_CHANGE_COLUMNS.includes(parsed.column) &&
      (parsed.dir === 'asc' || parsed.dir === 'desc')
    ) {
      return parsed
    }
  } catch {
    // ignore storage errors
  }
  return null
}

export function saveWatchlistDockSort(sort: DockSort): void {
  try {
    if (sort) localStorage.setItem(WATCHLIST_DOCK_SORT_STORAGE_KEY, JSON.stringify(sort))
    else localStorage.removeItem(WATCHLIST_DOCK_SORT_STORAGE_KEY)
  } catch {
    // ignore storage errors
  }
}

export function loadCollapsedWatchlists(): Set<string> {
  try {
    const raw = localStorage.getItem(WATCHLIST_DOCK_COLLAPSED_STORAGE_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? new Set(parsed.filter(id => typeof id === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

export function saveCollapsedWatchlists(ids: Set<string>): void {
  try {
    localStorage.setItem(WATCHLIST_DOCK_COLLAPSED_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // ignore storage errors
  }
}

export function toggleCollapsedWatchlist(ids: Set<string>, watchlistId: string): Set<string> {
  const next = new Set(ids)
  if (next.has(watchlistId)) next.delete(watchlistId)
  else next.add(watchlistId)
  saveCollapsedWatchlists(next)
  return next
}

/**
 * Sorts a watchlist's symbols by a rolling-window change column. Returns the
 * incoming (watchlist) order untouched when no sort is active. Symbols without
 * data sink to the bottom regardless of direction.
 */
export function sortDockSymbols(
  symbols: WatchlistSymbol[],
  broker: string,
  accountEnv: string,
  windowChanges: WindowChangesLookup,
  sort: DockSort,
): WatchlistSymbol[] {
  if (!sort) return symbols

  const missing = sort.dir === 'desc' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  const valueOf = (symbol: WatchlistSymbol) => {
    const key = watchlistTickKey(broker, accountEnv, symbol.symboltoken)
    const value = windowChanges[key]?.[sort.column]
    return value != null && Number.isFinite(value) ? value : missing
  }

  return [...symbols].sort((a, b) => {
    const diff = valueOf(b) - valueOf(a)
    const ordered = sort.dir === 'desc' ? diff : -diff
    if (ordered !== 0) return ordered
    return a.tradingsymbol.localeCompare(b.tradingsymbol)
  })
}
