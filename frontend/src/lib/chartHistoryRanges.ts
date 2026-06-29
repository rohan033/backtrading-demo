import type { WatchlistSanitizedCandle } from './watchlistCandles'

/** Contiguous 1-minute bar span we already fetched from the API. */
export type CachedTimeRange = {
  start: number
  end: number
  fetchedAt: number
}

const ONE_MINUTE = 60

export function currentMinuteBucket(): number {
  return Math.floor(Date.now() / 1000 / ONE_MINUTE) * ONE_MINUTE
}

/** Build merged contiguous ranges from sorted 1-minute candles. */
export function rangesFromCandles(
  candles: WatchlistSanitizedCandle[],
  fetchedAt = Date.now(),
): CachedTimeRange[] {
  if (!candles.length) return []

  const sorted = [...candles].sort((a, b) => a.time - b.time)
  const ranges: CachedTimeRange[] = []
  let start = sorted[0].time
  let end = sorted[0].time

  for (let i = 1; i < sorted.length; i += 1) {
    const time = sorted[i].time
    if (time <= end + ONE_MINUTE) {
      end = time
      continue
    }
    ranges.push({ start, end, fetchedAt })
    start = time
    end = time
  }

  ranges.push({ start, end, fetchedAt })
  return mergeTimeRanges(ranges)
}

export function mergeTimeRanges(ranges: CachedTimeRange[]): CachedTimeRange[] {
  if (!ranges.length) return []

  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: CachedTimeRange[] = []
  let current = { ...sorted[0] }

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]
    if (next.start <= current.end + ONE_MINUTE) {
      current.end = Math.max(current.end, next.end)
      current.fetchedAt = Math.max(current.fetchedAt, next.fetchedAt)
      continue
    }
    merged.push(current)
    current = { ...next }
  }

  merged.push(current)
  return merged
}

export function mergeRangeLists(
  base: CachedTimeRange[],
  incoming: CachedTimeRange[],
): CachedTimeRange[] {
  return mergeTimeRanges([...base, ...incoming])
}

/** True when every 1-minute bar in [windowStart, windowEnd] is cached. */
export function isWindowCovered(
  ranges: CachedTimeRange[],
  windowStart: number,
  windowEnd: number,
): boolean {
  if (windowStart > windowEnd) return true
  return mergeTimeRanges(ranges).some(
    range => range.start <= windowStart && range.end >= windowEnd,
  )
}

export function recordFetchedWindow(
  ranges: CachedTimeRange[],
  windowStart: number,
  windowEnd: number,
  fetchedAt = Date.now(),
): CachedTimeRange[] {
  return mergeRangeLists(ranges, [{ start: windowStart, end: windowEnd, fetchedAt }])
}

/** Whole minutes missing between the newest cached bar and now. */
export function missingTailBarCount(candles: WatchlistSanitizedCandle[]): number {
  const newest = candles[candles.length - 1]?.time
  if (!newest) return Number.POSITIVE_INFINITY
  return Math.max(0, (currentMinuteBucket() - newest) / ONE_MINUTE)
}

/**
 * Size the recent-candles request from the gap — e.g. 5 missing minutes → ~8 bars,
 * not a full 1000-bar refetch.
 */
export function tailFetchCount(
  missingMinutes: number,
  maxCount: number,
  bufferMinutes = 2,
): number {
  if (!Number.isFinite(missingMinutes) || missingMinutes <= 0) return 0
  return Math.min(Math.ceil(missingMinutes) + bufferMinutes, maxCount)
}

export function historyPageWindow(
  oldestBarTime: number,
  pageSizeMinutes: number,
): { windowStart: number; windowEnd: number } {
  const pageEndExclusive = Math.floor(oldestBarTime / ONE_MINUTE) * ONE_MINUTE
  const windowStart = pageEndExclusive - pageSizeMinutes * ONE_MINUTE
  const windowEnd = pageEndExclusive - ONE_MINUTE
  return { windowStart, windowEnd }
}
