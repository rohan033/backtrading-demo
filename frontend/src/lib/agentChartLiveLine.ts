import type { LineData } from 'lightweight-charts'

import { buildFlowingLinePoints } from '@/lib/watchlistFeedReuse'
import type { PriceSample } from '@/lib/watchlistChangeColumns'
import {
  mergeLiveTickIntoWatchlistCandles,
  type WatchlistSanitizedCandle,
} from '@/lib/watchlistCandles'

const LIVE_TAIL_SEC = 30 * 60

/** Merge REST candle history with sub-minute live tick samples (same as candidate mini charts). */
export function mergeHistoryWithLiveTail(
  candles: WatchlistSanitizedCandle[],
  samples: PriceSample[],
  ltp: number | null,
): LineData[] {
  const historyLine: LineData[] = candles
    .filter(row => Number.isFinite(row.close) && row.close > 0)
    .map(row => ({ time: row.time as LineData['time'], value: row.close }))

  const liveLine = buildFlowingLinePoints(samples, ltp) as LineData[]
  if (!liveLine.length) return historyLine

  const tailStart = Math.floor(Date.now() / 1000) - LIVE_TAIL_SEC
  const liveTail = liveLine.filter(point => Number(point.time) >= tailStart)
  if (!historyLine.length) return liveTail

  const historyCutoff = liveTail[0]?.time ?? tailStart
  const historyPart = historyLine.filter(point => point.time < historyCutoff)
  const merged = [...historyPart, ...liveTail]

  if (merged.length >= 2) return merged

  const withLive = mergeLiveTickIntoWatchlistCandles(candles, ltp)
  return withLive
    .filter(row => Number.isFinite(row.close) && row.close > 0)
    .map(row => ({ time: row.time as LineData['time'], value: row.close }))
}
