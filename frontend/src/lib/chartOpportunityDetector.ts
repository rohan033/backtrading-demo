import type { WatchlistSanitizedCandle } from './watchlistCandles'
import { chartScanContextMinutes, minChartScanBars } from './chartOpportunityConfig'

export type ChartOpportunityKind =
  | 'breakout_up'
  | 'breakout_down'
  | 'momentum_up'
  | 'momentum_down'
  | 'rsi_reversal_up'
  | 'rsi_reversal_down'
  | 'volume_spike'

export type ChartOpportunityDirection = 'long' | 'short'

export type ChartOpportunityIndicators = {
  rsi: number | null
  momentum5mPct: number
  momentum15mPct: number
  volumeZ: number
  atrPct: number
  sma20DistancePct: number
}

export type ChartOpportunityLevels = {
  entry: number
  stop: number
  target: number
  riskReward: number
}

export type ChartOpportunitySignal = {
  id: string
  kind: ChartOpportunityKind
  direction: ChartOpportunityDirection
  score: number
  fromTime: number
  toTime: number
  triggerTime: number
  price: number
  lookbackMinutes: number
  indicators: ChartOpportunityIndicators
  levels: ChartOpportunityLevels
  reasons: string[]
}

export type ChartOpportunityDetectOptions = {
  lookbackMinutes?: number
  minScore?: number
  minBars?: number
  contextBars?: number
}

const DEFAULT_LOOKBACK_MINUTES = 30
const DEFAULT_MIN_SCORE = 62
const DEFAULT_MIN_BARS = 20
const DEFAULT_CONTEXT_BARS = 5

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

function computeRsi(closes: number[], period = 14): number | null {
  if (closes.length <= period) return null

  let gains = 0
  let losses = 0
  for (let i = closes.length - period; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1]
    if (delta >= 0) gains += delta
    else losses -= delta
  }

  if (gains === 0 && losses === 0) return 50
  if (losses === 0) return 100
  if (gains === 0) return 0

  const rs = gains / losses
  return 100 - 100 / (1 + rs)
}

function computeAtr(candles: WatchlistSanitizedCandle[], period = 14): number | null {
  if (candles.length <= period) return null

  const ranges: number[] = []
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const prevClose = candles[i - 1]?.close ?? candles[i].open
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    )
    ranges.push(tr)
  }
  return mean(ranges)
}

function pctChange(from: number, to: number): number {
  if (!Number.isFinite(from) || from === 0) return 0
  return ((to - from) / from) * 100
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

function buildLevels(
  direction: ChartOpportunityDirection,
  entry: number,
  atr: number,
): ChartOpportunityLevels {
  const stopDistance = Math.max(atr * 1.5, entry * 0.0015)
  const targetDistance = Math.max(atr * 2.5, entry * 0.0025)
  const stop = direction === 'long' ? entry - stopDistance : entry + stopDistance
  const target = direction === 'long' ? entry + targetDistance : entry - targetDistance
  const risk = Math.abs(entry - stop)
  const reward = Math.abs(target - entry)
  return {
    entry,
    stop,
    target,
    riskReward: risk > 0 ? reward / risk : 0,
  }
}

function signalId(kind: ChartOpportunityKind, triggerTime: number): string {
  return `${kind}-${triggerTime}`
}

export function buildChartScanWindow(
  candles: WatchlistSanitizedCandle[],
  lookbackMinutes = DEFAULT_LOOKBACK_MINUTES,
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

export function detectChartOpportunity(
  candles: WatchlistSanitizedCandle[],
  options: ChartOpportunityDetectOptions = {},
): ChartOpportunitySignal | null {
  const lookbackMinutes = options.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE
  const minBars = options.minBars ?? minChartScanBars(lookbackMinutes)
  const contextBars = options.contextBars ?? DEFAULT_CONTEXT_BARS

  const signalWindow = windowCandles(candles, lookbackMinutes)
  if (signalWindow.length < minBars) return null

  const window = windowCandles(candles, chartScanContextMinutes(lookbackMinutes))
  if (window.length < DEFAULT_MIN_BARS) return null

  const closes = window.map(candle => candle.close)
  const volumes = window.map(candle => candle.volume)
  const latest = signalWindow[signalWindow.length - 1]
  const prev = signalWindow.length >= 2
    ? signalWindow[signalWindow.length - 2]
    : window[window.length - 2]
  if (!latest || !prev) return null

  const rsi = computeRsi(closes)
  const atr = computeAtr(window)
  if (atr == null || atr <= 0) return null

  const sma20 = mean(closes.slice(-20))
  const recentVolumes = volumes.slice(-20, -1)
  const volumeMean = mean(recentVolumes)
  const volumeStd = stddev(recentVolumes)
  const volumeZ = volumeStd > 0
    ? (latest.volume - volumeMean) / volumeStd
    : latest.volume > volumeMean ? 1 : 0

  const close5 = closes[Math.max(0, closes.length - 6)] ?? closes[0]
  const close15 = closes[Math.max(0, closes.length - 16)] ?? closes[0]
  const momentum5mPct = pctChange(close5, latest.close)
  const momentum15mPct = pctChange(close15, latest.close)
  const sma20DistancePct = pctChange(sma20, latest.close)

  const priorHighs = window.slice(-21, -1).map(candle => candle.high)
  const priorLows = window.slice(-21, -1).map(candle => candle.low)
  const rangeHigh = Math.max(...priorHighs)
  const rangeLow = Math.min(...priorLows)

  const breakoutUp = latest.close > rangeHigh
  const breakoutDown = latest.close < rangeLow
  const bullishCandle = latest.close >= latest.open
  const bearishCandle = latest.close < latest.open

  const reasons: string[] = []
  let score = 0
  let kind: ChartOpportunityKind = 'momentum_up'
  let direction: ChartOpportunityDirection = 'long'

  if (breakoutUp) {
    kind = 'breakout_up'
    direction = 'long'
    score += 28
    reasons.push(`Price broke above ${lookbackMinutes}m range high`)
  } else if (breakoutDown) {
    kind = 'breakout_down'
    direction = 'short'
    score += 28
    reasons.push(`Price broke below ${lookbackMinutes}m range low`)
  }

  if (momentum5mPct > 0.35 && momentum15mPct > 0.25) {
    score += 18
    if (!breakoutDown) {
      kind = breakoutUp ? kind : 'momentum_up'
      direction = 'long'
    }
    reasons.push(`Upside momentum (${momentum15mPct.toFixed(2)}% / 15m)`)
  } else if (momentum5mPct < -0.35 && momentum15mPct < -0.25) {
    score += 18
    if (!breakoutUp) {
      kind = breakoutDown ? kind : 'momentum_down'
      direction = 'short'
    }
    reasons.push(`Downside momentum (${momentum15mPct.toFixed(2)}% / 15m)`)
  }

  // Gradual drift inside the scan window (e.g. slow bleed on MSFT).
  const signalCloses = signalWindow.map(candle => candle.close)
  const windowStartClose = signalCloses[0]
  const windowMovePct = pctChange(windowStartClose, latest.close)
  if (windowMovePct <= -0.55) {
    score += 12
    if (!breakoutUp) {
      kind = 'momentum_down'
      direction = 'short'
    }
    reasons.push(`${lookbackMinutes}m drift lower (${windowMovePct.toFixed(2)}%)`)
  } else if (windowMovePct >= 0.55) {
    score += 12
    if (!breakoutDown) {
      kind = 'momentum_up'
      direction = 'long'
    }
    reasons.push(`${lookbackMinutes}m drift higher (${windowMovePct.toFixed(2)}%)`)
  }

  if (rsi != null && rsi <= 32 && bullishCandle) {
    score += 16
    kind = 'rsi_reversal_up'
    direction = 'long'
    reasons.push(`RSI oversold rebound (${rsi.toFixed(1)})`)
  } else if (rsi != null && rsi >= 68 && bearishCandle) {
    score += 16
    kind = 'rsi_reversal_down'
    direction = 'short'
    reasons.push(`RSI overbought fade (${rsi.toFixed(1)})`)
  }

  if (volumeZ >= 1.8) {
    score += 14
    if (kind === 'momentum_up' || kind === 'momentum_down') kind = 'volume_spike'
    reasons.push(`Volume spike (z=${volumeZ.toFixed(1)})`)
  }

  if (Math.abs(sma20DistancePct) >= 0.8) {
    score += 8
    reasons.push(`Stretched vs 20-bar mean (${sma20DistancePct.toFixed(2)}%)`)
  }

  const atrPct = (atr / latest.close) * 100
  if (atrPct >= 0.15) {
    score += 6
    reasons.push(`Elevated volatility (ATR ${atrPct.toFixed(2)}%)`)
  }

  if (score < minScore || reasons.length < 2) return null

  const contextIndex = Math.max(0, signalWindow.length - contextBars - 1)
  const fromTime = signalWindow[contextIndex]?.time ?? latest.time
  const levels = buildLevels(direction, latest.close, atr)

  return {
    id: signalId(kind, latest.time),
    kind,
    direction,
    score: Math.min(100, score),
    fromTime,
    toTime: latest.time,
    triggerTime: latest.time,
    price: latest.close,
    lookbackMinutes,
    indicators: {
      rsi,
      momentum5mPct,
      momentum15mPct,
      volumeZ,
      atrPct,
      sma20DistancePct,
    },
    levels,
    reasons,
  }
}
