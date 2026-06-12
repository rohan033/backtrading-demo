import type { WatchlistChangeWindowId } from './watchlistChangeColumns'

export const STICKY_FEED_STORAGE_KEY = 'sticky-watchlist-feed-v1'

/** Windows offered in the sticky feed rank selector (per wireframe). */
export const STICKY_FEED_RANK_WINDOWS: { id: WatchlistChangeWindowId; label: string }[] = [
  { id: '1m', label: '1m' },
  { id: '2m', label: '2m' },
  { id: '5m', label: '5m' },
]

/** How often the top-5 slot order is re-sorted (% on each ticker still updates live). */
export const STICKY_FEED_SORT_INTERVALS: { ms: number; label: string }[] = [
  { ms: 10_000, label: '10s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 120_000, label: '2m' },
  { ms: 300_000, label: '5m' },
]

export const DEFAULT_STICKY_FEED_SORT_INTERVAL_MS = 30_000

export type StickyFeedConfig = {
  expanded: boolean
  column: WatchlistChangeWindowId
  sortIntervalMs: number
}

export const DEFAULT_STICKY_FEED_CONFIG: StickyFeedConfig = {
  expanded: true,
  column: '1m',
  sortIntervalMs: DEFAULT_STICKY_FEED_SORT_INTERVAL_MS,
}

function normalizeSortIntervalMs(value: unknown): number {
  const allowed = new Set(STICKY_FEED_SORT_INTERVALS.map(option => option.ms))
  const ms = Number(value)
  if (Number.isFinite(ms) && allowed.has(ms)) return ms
  return DEFAULT_STICKY_FEED_SORT_INTERVAL_MS
}

export function stickyFeedSortIntervalLabel(ms: number): string {
  return STICKY_FEED_SORT_INTERVALS.find(option => option.ms === ms)?.label ?? '30s'
}

export function loadStickyFeedConfig(): StickyFeedConfig {
  try {
    const raw = localStorage.getItem(STICKY_FEED_STORAGE_KEY)
    if (!raw) return DEFAULT_STICKY_FEED_CONFIG
    const parsed = JSON.parse(raw) as Partial<StickyFeedConfig>
    const allowed = new Set(STICKY_FEED_RANK_WINDOWS.map(window => window.id))
    const column =
      typeof parsed.column === 'string' && allowed.has(parsed.column as WatchlistChangeWindowId)
        ? (parsed.column as WatchlistChangeWindowId)
        : DEFAULT_STICKY_FEED_CONFIG.column
    return {
      expanded: parsed.expanded !== false,
      column,
      sortIntervalMs: normalizeSortIntervalMs(parsed.sortIntervalMs),
    }
  } catch {
    return DEFAULT_STICKY_FEED_CONFIG
  }
}

export function saveStickyFeedConfig(config: StickyFeedConfig): void {
  localStorage.setItem(STICKY_FEED_STORAGE_KEY, JSON.stringify(config))
}
