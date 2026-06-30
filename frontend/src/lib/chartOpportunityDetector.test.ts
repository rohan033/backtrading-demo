import { describe, expect, it } from 'vitest'

import { detectChartOpportunity } from './chartOpportunityDetector'
import type { WatchlistSanitizedCandle } from './watchlistCandles'

function candle(
  time: number,
  close: number,
  opts: Partial<WatchlistSanitizedCandle> = {},
): WatchlistSanitizedCandle {
  return {
    time,
    open: opts.open ?? close,
    high: opts.high ?? close + 0.2,
    low: opts.low ?? close - 0.2,
    close,
    volume: opts.volume ?? 100,
  }
}

describe('detectChartOpportunity', () => {
  it('detects upside breakout with momentum and volume', () => {
    const base = 1_700_000_000
    const candles: WatchlistSanitizedCandle[] = []
    for (let i = 0; i < 24; i += 1) {
      candles.push(candle(base + i * 60, 100 + i * 0.02, { volume: 80 }))
    }
    candles.push(candle(base + 24 * 60, 101.2, { high: 101.4, low: 100.9, volume: 420 }))

    const signal = detectChartOpportunity(candles, { minScore: 50 })
    expect(signal).not.toBeNull()
    expect(signal?.direction).toBe('long')
    expect(signal?.levels.riskReward).toBeGreaterThan(0)
  })

  it('returns null when there is not enough history', () => {
    const signal = detectChartOpportunity([
      candle(1, 10),
      candle(61, 10.1),
    ])
    expect(signal).toBeNull()
  })
})
