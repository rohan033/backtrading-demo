import type { WatchlistSanitizedCandle } from './watchlistCandles'
import {
  CHART_SCAN_LOOKBACK_OPTIONS,
  chartScanContextMinutes,
  DEFAULT_CHART_SCAN_LOOKBACK_MINUTES,
  minChartScanBars,
  type ChartScanLookbackMinutes,
} from './chartOpportunityConfig'

export type ChartLevelOverlay = {
  rangeHigh: number
  rangeLow: number
  sma20: number
  currentPrice: number
  lookbackMinutes: number
}

export const CHART_LEVEL_LOOKBACK_KEY = 'home-chart-level-lookback-minutes'
export const HOME_CHART_LEVELS_KEY = 'home-chart-levels'

const MIN_LEVEL_CONTEXT_MINUTES = 20

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function windowCandles(
  candles: WatchlistSanitizedCandle[],
  lookbackMinutes: number,
): WatchlistSanitizedCandle[] {
  if (!candles.length) return []
  const latestTime = candles[candles.length - 1].time
  const cutoff = latestTime - lookbackMinutes * 60
  return candles.filter(candle => candle.time >= cutoff)
}

export function isChartLevelLookbackMinutes(value: number): value is ChartScanLookbackMinutes {
  return CHART_SCAN_LOOKBACK_OPTIONS.some(option => option.minutes === value)
}

export function loadChartLevelLookbackMinutes(): ChartScanLookbackMinutes {
  try {
    const raw = Number(localStorage.getItem(CHART_LEVEL_LOOKBACK_KEY))
    if (isChartLevelLookbackMinutes(raw)) return raw
  } catch {
    // ignore
  }
  return DEFAULT_CHART_SCAN_LOOKBACK_MINUTES
}

export function saveChartLevelLookbackMinutes(minutes: ChartScanLookbackMinutes) {
  try {
    localStorage.setItem(CHART_LEVEL_LOOKBACK_KEY, String(minutes))
  } catch {
    // ignore
  }
}

export function buildChartLevelWindow(
  candles: WatchlistSanitizedCandle[],
  lookbackMinutes = DEFAULT_CHART_SCAN_LOOKBACK_MINUTES,
): { fromTime: number; toTime: number } | null {
  if (!candles.length) return null
  const window = windowCandles(candles, lookbackMinutes)
  if (window.length < 2) return null
  const latest = candles[candles.length - 1]
  return {
    fromTime: window[0].time,
    toTime: latest.time,
  }
}

export function buildChartLevelOverlay(
  candles: WatchlistSanitizedCandle[],
  lookbackMinutes = DEFAULT_CHART_SCAN_LOOKBACK_MINUTES,
): ChartLevelOverlay | null {
  const bandWindow = windowCandles(candles, lookbackMinutes)
  if (bandWindow.length < minChartScanBars(lookbackMinutes)) return null

  const window = windowCandles(candles, chartScanContextMinutes(lookbackMinutes))
  if (window.length < MIN_LEVEL_CONTEXT_MINUTES) return null

  const closes = window.map(candle => candle.close)
  const latest = window[window.length - 1]
  if (!latest) return null

  const priorHighs = window.slice(-21, -1).map(candle => candle.high)
  const priorLows = window.slice(-21, -1).map(candle => candle.low)
  if (!priorHighs.length || !priorLows.length) return null

  return {
    rangeHigh: Math.max(...priorHighs),
    rangeLow: Math.min(...priorLows),
    sma20: mean(closes.slice(-20)),
    currentPrice: latest.close,
    lookbackMinutes,
  }
}
