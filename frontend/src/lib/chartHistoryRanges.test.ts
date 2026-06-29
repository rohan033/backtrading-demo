import { describe, expect, it } from 'vitest'

import {
  isWindowCovered,
  missingTailBarCount,
  rangesFromCandles,
  recordFetchedWindow,
  tailFetchCount,
} from './chartHistoryRanges'
import type { WatchlistSanitizedCandle } from './watchlistCandles'

function bar(time: number): WatchlistSanitizedCandle {
  return { time, open: 1, high: 1, low: 1, close: 1, volume: 1 }
}

describe('chartHistoryRanges', () => {
  it('derives contiguous ranges from minute bars', () => {
    const ranges = rangesFromCandles([
      bar(100),
      bar(300),
      bar(360),
      bar(420),
    ], 1)

    expect(ranges).toEqual([
      { start: 100, end: 100, fetchedAt: 1 },
      { start: 300, end: 420, fetchedAt: 1 },
    ])
  })

  it('sizes tail fetch from the missing minute gap', () => {
    expect(tailFetchCount(5, 1000)).toBe(7)
    expect(tailFetchCount(0, 1000)).toBe(0)
    expect(tailFetchCount(995, 1000)).toBe(997)
  })

  it('tracks fetched windows for skip logic', () => {
    const ranges = recordFetchedWindow([], 0, 240, 42)
    expect(isWindowCovered(ranges, 60, 180)).toBe(true)
    expect(isWindowCovered(ranges, 0, 300)).toBe(false)
  })

  it('counts missing tail bars from newest cached minute', () => {
    const nowMinute = Math.floor(Date.now() / 1000 / 60) * 60
    expect(missingTailBarCount([bar(nowMinute - 300), bar(nowMinute - 240)])).toBe(4)
  })
})
