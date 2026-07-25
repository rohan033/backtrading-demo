import type { WatchlistSanitizedCandle } from './watchlistCandles'

export type MiniChartVolumeRow = {
  volume: number
  fillPct: number
  bullish: boolean
  surge: 'positive' | 'negative' | null
}

const SURGE_RATIO = 1.35

export function buildMiniChartVolumeRows(
  bars: WatchlistSanitizedCandle[],
  priorBars: WatchlistSanitizedCandle[],
): MiniChartVolumeRow[] {
  if (!bars.length) return []

  const maxVol = Math.max(...bars.map(bar => bar.volume), 1)
  const baselineSource = priorBars.length ? priorBars : bars
  const baseline = baselineSource.reduce((sum, bar) => sum + bar.volume, 0) / baselineSource.length

  return bars.map(bar => {
    const volume = Number.isFinite(bar.volume) ? Math.max(0, bar.volume) : 0
    const bullish = bar.close >= bar.open
    const fillPct = maxVol > 0 ? (volume / maxVol) * 100 : 0
    const ratio = baseline > 0 ? volume / baseline : 0
    const isSurge = volume > 0 && ratio >= SURGE_RATIO
    const surge = isSurge ? (bullish ? 'positive' : 'negative') : null
    return { volume, fillPct, bullish, surge }
  })
}

export function formatCompactVolume(volume: number): string {
  if (!Number.isFinite(volume) || volume <= 0) return ''
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`
  return String(Math.round(volume))
}
