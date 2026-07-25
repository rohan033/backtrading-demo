import type { WatchlistSanitizedCandle } from './watchlistCandles'

export type HaltDirection = 'uphalt' | 'downhalt' | 'flat' | 'unknown'

export function aggregateCandlesToMinutes(
  candles: WatchlistSanitizedCandle[],
  intervalMinutes: number,
): WatchlistSanitizedCandle[] {
  if (!candles.length || intervalMinutes <= 1) return candles

  const bucketSec = intervalMinutes * 60
  const buckets = new Map<number, WatchlistSanitizedCandle>()

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketSec) * bucketSec
    const existing = buckets.get(bucket)
    if (!existing) {
      buckets.set(bucket, { ...candle, time: bucket })
      continue
    }
    existing.high = Math.max(existing.high, candle.high)
    existing.low = Math.min(existing.low, candle.low)
    existing.close = candle.close
    existing.volume += candle.volume
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

export function classifyHaltDirection(
  oneMinuteCandles: WatchlistSanitizedCandle[],
  options?: {
    pauseThreshold?: number | null
    barCount?: number
    flatThresholdPct?: number
  },
): { direction: HaltDirection; changePct: number | null; reason: string } {
  const barCount = options?.barCount ?? 5
  const flatThresholdPct = options?.flatThresholdPct ?? 0.35

  const fiveMin = aggregateCandlesToMinutes(oneMinuteCandles, 5)
  if (fiveMin.length < 2) {
    return { direction: 'unknown', changePct: null, reason: 'Not enough candle history' }
  }

  const completed = fiveMin.slice(0, -1)
  const window = completed.slice(-barCount)
  if (window.length < 2) {
    return { direction: 'unknown', changePct: null, reason: 'Need more 5m bars' }
  }

  const first = window[0]
  const last = window[window.length - 1]
  const changePct = first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null

  const threshold = options?.pauseThreshold
  if (threshold != null && Number.isFinite(threshold) && threshold > 0 && last.close > 0) {
    const vsThreshold = ((last.close - threshold) / threshold) * 100
    if (Math.abs(vsThreshold) >= flatThresholdPct) {
      const dir: HaltDirection = vsThreshold > 0 ? 'uphalt' : 'downhalt'
      return {
        direction: dir,
        changePct,
        reason: `Last close ${vsThreshold > 0 ? 'above' : 'below'} pause threshold`,
      }
    }
  }

  if (changePct == null || !Number.isFinite(changePct)) {
    return { direction: 'unknown', changePct: null, reason: 'Invalid price window' }
  }
  if (Math.abs(changePct) < flatThresholdPct) {
    return { direction: 'flat', changePct, reason: 'Flat pre-halt momentum' }
  }
  return {
    direction: changePct > 0 ? 'uphalt' : 'downhalt',
    changePct,
    reason: `${barCount}×5m ${changePct > 0 ? 'up' : 'down'} ${Math.abs(changePct).toFixed(2)}%`,
  }
}
