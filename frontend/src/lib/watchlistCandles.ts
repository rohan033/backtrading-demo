import type { PriceSample } from './watchlistChangeColumns'
import type { PriceSample } from './watchlistChangeColumns'
import type { WatchlistChartSymbol } from './watchlistUniqueSymbols'

export type WatchlistSanitizedCandle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export const WATCHLIST_CANDLE_UP = '#00e676'
export const WATCHLIST_CANDLE_DOWN = '#ff5252'
export const WATCHLIST_CANDLE_NEUTRAL_UP = '#00c853'
export const WATCHLIST_CANDLE_NEUTRAL_DOWN = '#ff1744'

export const WATCHLIST_CHART_CANDLE_COUNT = 1000

export function ohlcCandlesToPriceSamples(candles: WatchlistSanitizedCandle[]): PriceSample[] {
  return candles.map(candle => ({
    ts: candle.time * 1000,
    ltp: candle.close,
  }))
}

export function mergePriceSamples(
  historical: PriceSample[],
  live: PriceSample[],
): PriceSample[] {
  const map = new Map<number, PriceSample>()
  for (const sample of historical) map.set(sample.ts, sample)
  for (const sample of live) map.set(sample.ts, sample)
  return [...map.values()].sort((a, b) => a.ts - b.ts)
}

export function sanitizeWatchlistCandles(candles: unknown[]): WatchlistSanitizedCandle[] {
  if (!candles?.length) return []

  const sanitized: WatchlistSanitizedCandle[] = []
  for (const candle of candles) {
    if (!candle || typeof candle !== 'object') continue
    const row = candle as Record<string, unknown>
    const time = Number(row.time)
    const open = Number(row.open)
    const high = Number(row.high)
    const low = Number(row.low)
    const close = Number(row.close)
    if (![time, open, high, low, close].every(Number.isFinite)) continue
    if (Math.min(open, high, low, close) <= 0) continue

    const normalized: WatchlistSanitizedCandle = {
      time: Math.floor(time / 60) * 60,
      open,
      high: Math.max(high, open, low, close),
      low: Math.min(low, open, high, close),
      close,
      volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : 0,
    }
    const last = sanitized[sanitized.length - 1]
    if (last && normalized.time <= last.time) {
      sanitized[sanitized.length - 1] = normalized
    } else {
      sanitized.push(normalized)
    }
  }
  return sanitized
}

export function candlesToVolumeData(candles: WatchlistSanitizedCandle[]) {
  return candles.map(candle => ({
    time: candle.time,
    value: Number.isFinite(candle.volume) ? candle.volume : 0,
    color: candle.close >= candle.open ? 'rgba(0, 230, 118, 0.45)' : 'rgba(255, 82, 82, 0.45)',
  }))
}

export function mergeWatchlistCandleHistory(
  base: WatchlistSanitizedCandle[],
  incoming: WatchlistSanitizedCandle[],
): WatchlistSanitizedCandle[] {
  const merged = new Map(base.map(item => [item.time, item]))
  for (const candle of sanitizeWatchlistCandles(incoming)) {
    merged.set(candle.time, candle)
  }
  return [...merged.values()].sort((a, b) => a.time - b.time)
}

export function mergeLiveTickIntoWatchlistCandles(
  candles: WatchlistSanitizedCandle[],
  ltp: number | null | undefined,
): WatchlistSanitizedCandle[] {
  const price = Number(ltp)
  if (!Number.isFinite(price) || price <= 0) return candles

  const bucket = Math.floor(Date.now() / 1000 / 60) * 60
  const next = [...candles]
  const last = next[next.length - 1]

  if (last?.time === bucket) {
    next[next.length - 1] = {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    }
    return next
  }

  if (!last || bucket > last.time) {
    next.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    })
  }

  return sanitizeWatchlistCandles(next)
}

/** Aggregate tick samples into 1-minute candles (tick count stands in for volume). */
export function samplesToWatchlistCandles(samples: PriceSample[]): WatchlistSanitizedCandle[] {
  const buckets = new Map<number, WatchlistSanitizedCandle & { ticks: number }>()
  for (const sample of samples) {
    if (!Number.isFinite(sample.ltp) || sample.ltp <= 0) continue
    const time = Math.floor(sample.ts / 60_000) * 60
    const existing = buckets.get(time)
    if (!existing) {
      buckets.set(time, {
        time,
        open: sample.ltp,
        high: sample.ltp,
        low: sample.ltp,
        close: sample.ltp,
        volume: 1,
        ticks: 1,
      })
      continue
    }
    existing.high = Math.max(existing.high, sample.ltp)
    existing.low = Math.min(existing.low, sample.ltp)
    existing.close = sample.ltp
    existing.ticks += 1
    existing.volume = existing.ticks
  }

  return [...buckets.values()]
    .map(({ ticks: _ticks, ...candle }) => candle)
    .sort((a, b) => a.time - b.time)
}

/** Live forming bar only — no broker history. Uses ticks from the current minute. */
export function liveWatchlistCandles(
  samples: PriceSample[],
  ltp: number | null | undefined,
): WatchlistSanitizedCandle[] {
  const bucket = Math.floor(Date.now() / 1000 / 60) * 60
  const currentMinuteSamples = samples.filter(
    sample => Math.floor(sample.ts / 60_000) * 60 === bucket,
  )
  return mergeLiveTickIntoWatchlistCandles(
    samplesToWatchlistCandles(currentMinuteSamples),
    ltp,
  )
}

export async function fetchWatchlistSymbolCandles(
  symbol: WatchlistChartSymbol,
  count = WATCHLIST_CHART_CANDLE_COUNT,
): Promise<WatchlistSanitizedCandle[]> {
  const url =
    `/api/watchlist/candles` +
    `?broker=${encodeURIComponent(symbol.broker)}` +
    `&account_env=${encodeURIComponent(symbol.accountEnv)}` +
    `&symbol=${encodeURIComponent(symbol.tradingsymbol)}` +
    `&token=${encodeURIComponent(symbol.symboltoken)}` +
    `&count=${count}`
  const res = await fetch(url)
  if (!res.ok) return []
  const json = (await res.json()) as { data?: unknown[] }
  return sanitizeWatchlistCandles(Array.isArray(json.data) ? json.data : [])
}

export function applyWatchlistCandleColors(
  series: { applyOptions: (options: Record<string, string>) => void } | null,
  candle: WatchlistSanitizedCandle | null | undefined,
): void {
  if (!series || !candle) return
  const bullish = candle.close >= candle.open
  const upColor = bullish ? WATCHLIST_CANDLE_UP : WATCHLIST_CANDLE_NEUTRAL_UP
  const downColor = bullish ? WATCHLIST_CANDLE_NEUTRAL_DOWN : WATCHLIST_CANDLE_DOWN
  series.applyOptions({
    upColor,
    downColor,
    borderUpColor: upColor,
    borderDownColor: downColor,
    wickUpColor: upColor,
    wickDownColor: downColor,
  })
}

export function mergeLiveTailSamples(
  apiCandles: WatchlistSanitizedCandle[],
  samples: PriceSample[],
): WatchlistSanitizedCandle[] {
  if (!apiCandles.length) return apiCandles

  const currentBucket = Math.floor(Date.now() / 1000 / 60) * 60
  const sampleCandles = samplesToWatchlistCandles(samples)
  const forming = sampleCandles.find(candle => candle.time === currentBucket)
  if (!forming) return apiCandles

  const merged = [...apiCandles]
  const lastIdx = merged.length - 1
  const last = merged[lastIdx]

  if (forming.time === last.time) {
    merged[lastIdx] = {
      time: last.time,
      open: last.open,
      high: Math.max(last.high, forming.high),
      low: Math.min(last.low, forming.low),
      close: forming.close,
      volume: Math.max(last.volume, forming.volume),
    }
  } else if (forming.time > last.time) {
    merged.push(forming)
  }

  return sanitizeWatchlistCandles(merged)
}

export function applyWatchlistCandleViewport(
  chart: {
    timeScale: () => {
      applyOptions: (options: Record<string, number>) => void
      fitContent: () => void
      setVisibleLogicalRange: (range: { from: number; to: number }) => void
    }
  } | null,
  barCount: number,
  compact = false,
): void {
  if (!chart || barCount <= 0) return

  const visibleBars = compact ? 50 : 120
  const barSpacing = compact ? 3 : 8

  chart.timeScale().applyOptions({
    barSpacing,
    minBarSpacing: compact ? 1 : 3,
    rightOffset: compact ? 4 : 12,
  })

  if (barCount <= visibleBars) {
    chart.timeScale().fitContent()
    return
  }

  // Pin the viewport to recent bars so live candles stay readable on maximize.
  chart.timeScale().setVisibleLogicalRange({
    from: barCount - visibleBars,
    to: barCount + (compact ? 4 : 12),
  })
}
