const HEADER_COMPACT_KEY = 'watchlist-header-compact-v1'

export function loadWatchlistHeaderCompact(): boolean {
  try {
    return localStorage.getItem(HEADER_COMPACT_KEY) === '1'
  } catch {
    return false
  }
}

export function saveWatchlistHeaderCompact(compact: boolean): void {
  localStorage.setItem(HEADER_COMPACT_KEY, compact ? '1' : '0')
}
