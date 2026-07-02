import { MAX_WATCHLIST_HISTORY_MS, type PriceSample } from './watchlistChangeColumns'

const CACHE_VERSION = 1

type CachedSamples = {
  version: number
  tickKey: string
  expiresAt: number
  samples: PriceSample[]
}

function storageKey(tickKey: string): string {
  return `agent-chart-samples:${tickKey}`
}

export function loadAgentChartSamples(tickKey: string): PriceSample[] {
  if (!tickKey) return []
  try {
    const raw = sessionStorage.getItem(storageKey(tickKey))
    if (!raw) return []
    const parsed = JSON.parse(raw) as CachedSamples
    if (parsed.version !== CACHE_VERSION || parsed.tickKey !== tickKey) return []
    if (!Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(storageKey(tickKey))
      return []
    }
    return Array.isArray(parsed.samples) ? parsed.samples : []
  } catch {
    return []
  }
}

export function saveAgentChartSamples(tickKey: string, samples: PriceSample[]): void {
  if (!tickKey || !samples.length) return
  try {
    const now = Date.now()
    const cutoff = now - MAX_WATCHLIST_HISTORY_MS
    const payload: CachedSamples = {
      version: CACHE_VERSION,
      tickKey,
      expiresAt: now + MAX_WATCHLIST_HISTORY_MS,
      samples: samples.filter(sample => sample.ts >= cutoff).slice(-2000),
    }
    sessionStorage.setItem(storageKey(tickKey), JSON.stringify(payload))
  } catch {
    // ignore quota errors
  }
}

export function mergePriceSamples(...groups: PriceSample[][]): PriceSample[] {
  const map = new Map<number, PriceSample>()
  for (const group of groups) {
    for (const sample of group) {
      if (!Number.isFinite(sample.ltp) || sample.ltp <= 0) continue
      map.set(sample.ts, sample)
    }
  }
  return [...map.values()].sort((a, b) => a.ts - b.ts)
}
