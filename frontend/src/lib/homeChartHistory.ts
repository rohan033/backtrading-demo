import {
  historyPageWindow,
  isWindowCovered,
  mergeRangeLists,
  missingTailBarCount,
  rangesFromCandles,
  recordFetchedWindow,
  tailFetchCount,
  type CachedTimeRange,
} from './chartHistoryRanges'
import {
  fetchWatchlistOlderCandles,
  fetchWatchlistSymbolCandles,
  mergeWatchlistCandleHistory,
  sanitizeWatchlistCandles,
  WATCHLIST_CHART_CANDLE_COUNT,
  type WatchlistSanitizedCandle,
} from './watchlistCandles'
import {
  getWatchlistOhlcCache,
  setWatchlistOhlcCache,
} from './watchlistOhlcCache'
import type { WatchlistChartSymbol } from './watchlistUniqueSymbols'

/** ~3.5 days of 1-minute bars — balances history depth vs localStorage size. */
export const HOME_CHART_MAX_CANDLES = 5000
/** First paint batch — single eToro candles API call (max 1000). */
export const HOME_CHART_INITIAL_FETCH = WATCHLIST_CHART_CANDLE_COUNT
/** Bars per backwards pagination request. */
export const HOME_CHART_HISTORY_PAGE = 500
/** Max extra history pages after the initial fetch. */
export const HOME_CHART_MAX_HISTORY_PAGES = 8
/** Drop entire cache entry after this age. Historical ranges are kept until then. */
export const HOME_CHART_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
/** Re-fetch only the missing tail if the last tail refresh is older than this. */
export const HOME_CHART_TAIL_STALE_MS = 60 * 1000
const HOME_CHART_CACHE_PREFIX = 'home-chart-history:v2:'

type HomeChartCacheEntry = {
  fetchedAt: number
  tailFetchedAt?: number
  candles: WatchlistSanitizedCandle[]
  ranges: CachedTimeRange[]
  /** True once backwards pagination has finished (or cap reached). */
  historyComplete?: boolean
}

const memoryCache: Record<string, HomeChartCacheEntry> = {}
const initialInflight = new Map<string, Promise<WatchlistSanitizedCandle[]>>()
const backgroundInflight = new Map<string, Promise<WatchlistSanitizedCandle[]>>()
const tailInflight = new Map<string, Promise<WatchlistSanitizedCandle[]>>()

function cacheKey(tickKey: string): string {
  return `${HOME_CHART_CACHE_PREFIX}${tickKey}`
}

function trimToMax(candles: WatchlistSanitizedCandle[]): WatchlistSanitizedCandle[] {
  return candles.length > HOME_CHART_MAX_CANDLES
    ? candles.slice(-HOME_CHART_MAX_CANDLES)
    : candles
}

function isCacheExpired(entry: HomeChartCacheEntry): boolean {
  return Date.now() - entry.fetchedAt > HOME_CHART_CACHE_MAX_AGE_MS
}

function inferHistoryComplete(entry: HomeChartCacheEntry): boolean {
  if (entry.historyComplete === true) return true
  if (entry.historyComplete === false) return false
  if (entry.candles.length >= HOME_CHART_MAX_CANDLES) return true
  return entry.candles.length > HOME_CHART_INITIAL_FETCH
}

function normalizeCacheEntry(raw: Partial<HomeChartCacheEntry>): HomeChartCacheEntry | null {
  if (!raw?.fetchedAt || !Array.isArray(raw.candles)) return null
  const candles = trimToMax(sanitizeWatchlistCandles(raw.candles))
  if (!candles.length) return null

  const fetchedAt = raw.fetchedAt
  const ranges = Array.isArray(raw.ranges) && raw.ranges.length
    ? mergeRangeLists([], raw.ranges)
    : rangesFromCandles(candles, raw.tailFetchedAt ?? fetchedAt)

  return {
    fetchedAt,
    tailFetchedAt: raw.tailFetchedAt,
    candles,
    ranges,
    historyComplete: inferHistoryComplete({
      fetchedAt,
      candles,
      ranges,
      historyComplete: raw.historyComplete,
    }),
  }
}

function readLocalStorageEntry(tickKey: string): HomeChartCacheEntry | null {
  const keys = [
    cacheKey(tickKey),
    `home-chart-history:v1:${tickKey}`,
  ]

  for (const key of keys) {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) continue
      const parsed = JSON.parse(raw) as Partial<HomeChartCacheEntry>
      const entry = normalizeCacheEntry(parsed)
      if (!entry || isCacheExpired(entry)) continue
      return entry
    } catch {
      continue
    }
  }

  return null
}

function readCacheEntry(tickKey: string): HomeChartCacheEntry | null {
  const memory = memoryCache[tickKey]
  if (memory && !isCacheExpired(memory)) {
    return memory
  }

  const stored = readLocalStorageEntry(tickKey)
  if (stored) {
    memoryCache[tickKey] = stored
    return stored
  }

  const watchlistCached = getWatchlistOhlcCache(tickKey)
  if (watchlistCached?.length) {
    const fetchedAt = Date.now()
    const entry: HomeChartCacheEntry = {
      fetchedAt,
      tailFetchedAt: fetchedAt,
      candles: trimToMax(watchlistCached),
      ranges: rangesFromCandles(watchlistCached, fetchedAt),
      historyComplete: watchlistCached.length > HOME_CHART_INITIAL_FETCH,
    }
    memoryCache[tickKey] = entry
    return entry
  }

  return null
}

function writeCacheEntry(
  tickKey: string,
  candles: WatchlistSanitizedCandle[],
  options: {
    historyComplete: boolean
    ranges?: CachedTimeRange[]
    tailFetchedAt?: number
  },
): void {
  if (!candles.length) return

  const now = Date.now()
  const trimmed = trimToMax(candles)
  const entry: HomeChartCacheEntry = {
    fetchedAt: now,
    tailFetchedAt: options.tailFetchedAt ?? now,
    candles: trimmed,
    ranges: options.ranges ?? rangesFromCandles(trimmed, now),
    historyComplete: options.historyComplete,
  }
  memoryCache[tickKey] = entry
  setWatchlistOhlcCache(tickKey, entry.candles)

  try {
    localStorage.setItem(cacheKey(tickKey), JSON.stringify(entry))
  } catch {
    // Quota exceeded or private mode — ignore.
  }
}

export function readHomeChartCache(tickKey: string): WatchlistSanitizedCandle[] | null {
  return readCacheEntry(tickKey)?.candles ?? null
}

export function writeHomeChartCache(
  tickKey: string,
  candles: WatchlistSanitizedCandle[],
  historyComplete = false,
): void {
  writeCacheEntry(tickKey, candles, { historyComplete })
}

async function fetchRecentBatch(
  symbol: WatchlistChartSymbol,
  count: number,
): Promise<WatchlistSanitizedCandle[]> {
  if (count <= 0) return []
  return fetchWatchlistSymbolCandles(symbol, count)
}

function shouldRefreshTail(entry: HomeChartCacheEntry): boolean {
  const missing = missingTailBarCount(entry.candles)
  if (missing <= 0) return false
  const tailFetchedAt = entry.tailFetchedAt ?? entry.fetchedAt
  return Date.now() - tailFetchedAt >= HOME_CHART_TAIL_STALE_MS
}

async function refreshMissingTail(
  symbol: WatchlistChartSymbol,
  entry: HomeChartCacheEntry,
  onProgress?: (candles: WatchlistSanitizedCandle[]) => void,
): Promise<WatchlistSanitizedCandle[]> {
  const missing = missingTailBarCount(entry.candles)
  const count = tailFetchCount(missing, HOME_CHART_INITIAL_FETCH)
  if (count <= 0) return entry.candles

  const fresh = await fetchRecentBatch(symbol, count)
  if (!fresh.length) return entry.candles

  const merged = trimToMax(mergeWatchlistCandleHistory(entry.candles, fresh))
  const now = Date.now()
  const newest = fresh[fresh.length - 1]?.time ?? entry.candles[entry.candles.length - 1]?.time
  const oldestFresh = fresh[0]?.time ?? newest
  const ranges = recordFetchedWindow(
    entry.ranges,
    oldestFresh,
    newest ?? oldestFresh,
    now,
  )

  writeCacheEntry(symbol.tickKey, merged, {
    historyComplete: inferHistoryComplete({ ...entry, candles: merged, ranges }),
    ranges,
    tailFetchedAt: now,
  })
  onProgress?.(merged)
  return merged
}

function ensureTailRefresh(
  symbol: WatchlistChartSymbol,
  entry: HomeChartCacheEntry,
  onProgress?: (candles: WatchlistSanitizedCandle[]) => void,
): void {
  const { tickKey } = symbol
  if (tailInflight.has(tickKey)) return
  if (!shouldRefreshTail(entry)) return

  const latest = readCacheEntry(tickKey) ?? entry
  const task = refreshMissingTail(symbol, latest, onProgress).finally(() => {
    tailInflight.delete(tickKey)
  })
  tailInflight.set(tickKey, task)
  void task
}

async function paginateOlderHistory(
  symbol: WatchlistChartSymbol,
  seed: WatchlistSanitizedCandle[],
  seedRanges: CachedTimeRange[],
  onProgress?: (candles: WatchlistSanitizedCandle[]) => void,
): Promise<{ candles: WatchlistSanitizedCandle[]; ranges: CachedTimeRange[] }> {
  if (symbol.broker !== 'etoro') {
    return { candles: seed, ranges: seedRanges }
  }

  let merged = seed
  let ranges = seedRanges
  const now = Date.now()

  for (let page = 0; page < HOME_CHART_MAX_HISTORY_PAGES; page += 1) {
    if (merged.length >= HOME_CHART_MAX_CANDLES) break
    const oldest = merged[0]?.time
    if (!oldest) break

    const { windowStart, windowEnd } = historyPageWindow(oldest, HOME_CHART_HISTORY_PAGE)
    if (isWindowCovered(ranges, windowStart, windowEnd)) {
      break
    }

    const { candles: older, loadedCount } = await fetchWatchlistOlderCandles(
      symbol,
      oldest,
      HOME_CHART_HISTORY_PAGE,
    )
    if (!loadedCount || !older.length) break

    ranges = recordFetchedWindow(ranges, windowStart, windowEnd, now)
    const next = trimToMax(mergeWatchlistCandleHistory(older, merged))
    if (next.length === merged.length) break
    merged = next
    onProgress?.(merged)
  }

  return { candles: merged, ranges }
}

async function loadRemainingHistoryInBackground(
  symbol: WatchlistChartSymbol,
  entry: HomeChartCacheEntry,
  onProgress?: (candles: WatchlistSanitizedCandle[]) => void,
): Promise<WatchlistSanitizedCandle[]> {
  const { candles, ranges } = await paginateOlderHistory(
    symbol,
    entry.candles,
    entry.ranges,
    onProgress,
  )
  writeCacheEntry(symbol.tickKey, candles, {
    historyComplete: true,
    ranges,
    tailFetchedAt: entry.tailFetchedAt,
  })
  onProgress?.(candles)
  return candles
}

function ensureBackgroundPagination(
  symbol: WatchlistChartSymbol,
  entry: HomeChartCacheEntry,
  onProgress?: (candles: WatchlistSanitizedCandle[]) => void,
): void {
  const { tickKey } = symbol
  if (backgroundInflight.has(tickKey)) return
  if (symbol.broker !== 'etoro') return
  if (inferHistoryComplete(entry)) return
  if (entry.candles.length >= HOME_CHART_MAX_CANDLES) return

  const latest = readCacheEntry(tickKey) ?? entry
  const task = loadRemainingHistoryInBackground(symbol, latest, onProgress).finally(() => {
    backgroundInflight.delete(tickKey)
  })
  backgroundInflight.set(tickKey, task)
  void task
}

export type LoadHomeChartHistoryOptions = {
  /** When true, skip cache and refetch from the API. */
  force?: boolean
  /** Called as older batches arrive (and once when background load finishes). */
  onRefresh?: (candles: WatchlistSanitizedCandle[]) => void
}

/**
 * Progressive chart history for focused detail charts (Home, Watch & Trade, Strategies).
 * Caches contiguous time ranges and on refresh only fetches:
 * - the missing tail (sized to the gap, e.g. 5 min → ~7 bars), and
 * - older pages whose windows are not yet covered.
 */
export async function loadHomeChartHistory(
  symbol: WatchlistChartSymbol,
  options: LoadHomeChartHistoryOptions = {},
): Promise<WatchlistSanitizedCandle[]> {
  const { tickKey } = symbol

  if (!options.force) {
    const cached = readCacheEntry(tickKey)
    if (cached?.candles.length) {
      ensureTailRefresh(symbol, cached, options.onRefresh)
      if (!inferHistoryComplete(cached)) {
        ensureBackgroundPagination(symbol, cached, options.onRefresh)
      }
      return cached.candles
    }
  } else {
    delete memoryCache[tickKey]
    initialInflight.delete(tickKey)
    backgroundInflight.delete(tickKey)
    tailInflight.delete(tickKey)
  }

  const pending = initialInflight.get(tickKey)
  if (pending) return pending

  const task = (async () => {
    const initial = await fetchRecentBatch(symbol, HOME_CHART_INITIAL_FETCH)
    if (!initial.length) return []

    const now = Date.now()
    const newest = initial[initial.length - 1]?.time
    const oldest = initial[0]?.time ?? newest
    const ranges = oldest != null && newest != null
      ? recordFetchedWindow([], oldest, newest, now)
      : rangesFromCandles(initial, now)

    writeCacheEntry(tickKey, initial, {
      historyComplete: false,
      ranges,
      tailFetchedAt: now,
    })

    const entry = readCacheEntry(tickKey)
    if (entry) {
      ensureBackgroundPagination(symbol, entry, options.onRefresh)
    }
    return initial
  })().finally(() => {
    initialInflight.delete(tickKey)
  })

  initialInflight.set(tickKey, task)
  return task
}
