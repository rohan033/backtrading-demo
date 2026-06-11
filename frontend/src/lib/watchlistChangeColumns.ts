export const WATCHLIST_CHANGE_COLUMN_STORAGE_KEY = 'watchlist-change-columns-v1'

/** Rolling lookback windows computed from locally tracked LTP samples. */
export const WATCHLIST_CHANGE_WINDOWS = [
  { id: '1m', label: '1m', ms: 60_000 },
  { id: '2m', label: '2m', ms: 2 * 60_000 },
  { id: '5m', label: '5m', ms: 5 * 60_000 },
  { id: '10m', label: '10m', ms: 10 * 60_000 },
  { id: '30m', label: '30m', ms: 30 * 60_000 },
  { id: '4h', label: '4h', ms: 4 * 60 * 60_000 },
  { id: '6h', label: '6h', ms: 6 * 60 * 60_000 },
] as const

export type WatchlistChangeWindowId = (typeof WATCHLIST_CHANGE_WINDOWS)[number]['id']

export const WATCHLIST_CHANGE_WINDOW_IDS: WatchlistChangeWindowId[] =
  WATCHLIST_CHANGE_WINDOWS.map(window => window.id)

export const MAX_WATCHLIST_HISTORY_MS = 6 * 60 * 60_000 + 60_000

const DEFAULT_VISIBLE: WatchlistChangeWindowId[] = ['1m', '5m']

export function defaultVisibleChangeColumns(): WatchlistChangeWindowId[] {
  return [...DEFAULT_VISIBLE]
}

export function loadVisibleChangeColumns(): WatchlistChangeWindowId[] {
  try {
    const raw = localStorage.getItem(WATCHLIST_CHANGE_COLUMN_STORAGE_KEY)
    if (!raw) return defaultVisibleChangeColumns()
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return defaultVisibleChangeColumns()
    const allowed = new Set(WATCHLIST_CHANGE_WINDOW_IDS)
    const next = parsed.filter(
      (id): id is WatchlistChangeWindowId =>
        typeof id === 'string' && allowed.has(id as WatchlistChangeWindowId),
    )
    return next.length ? next : defaultVisibleChangeColumns()
  } catch {
    return defaultVisibleChangeColumns()
}
}

export function saveVisibleChangeColumns(columns: WatchlistChangeWindowId[]): void {
  localStorage.setItem(WATCHLIST_CHANGE_COLUMN_STORAGE_KEY, JSON.stringify(columns))
}

/** Minimum card width so every column fits without clipping. */
export function watchlistTableMinWidthPx(visibleChangeColumnCount: number): number {
  const symbol = 76
  const last = 76
  const trend = 36
  const change = 58 * visibleChangeColumnCount
  const tick = 64
  const remove = 32
  const chrome = 28
  return symbol + last + trend + change + tick + remove + chrome
}

export function buildWatchlistTableGrid(visibleChangeColumns: WatchlistChangeWindowId[]): string {
  const parts = [
    'minmax(4.5rem, 1.15fr)',
    '4.75rem',
    '2.25rem',
  ]
  for (const _column of visibleChangeColumns) {
    parts.push('3.625rem')
  }
  parts.push('4rem', '2rem')
  return parts.join(' ')
}

export function formatWindowChangePct(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

export function windowChangeTone(value: number | null | undefined): 'up' | 'down' | 'flat' | 'none' {
  if (value == null || Number.isNaN(value)) return 'none'
  if (value > 0) return 'up'
  if (value < 0) return 'down'
  return 'flat'
}

export type PriceSample = { ts: number; ltp: number }

export function appendPriceSample(
  samples: PriceSample[],
  ltp: number,
  ts: number,
): PriceSample[] {
  if (!Number.isFinite(ltp) || ltp <= 0) return samples

  const next = [...samples]
  const last = next[next.length - 1]
  if (last && last.ltp === ltp && ts - last.ts < 250) {
    return next
  }
  if (last && ts <= last.ts) {
    next[next.length - 1] = { ts, ltp }
  } else {
    next.push({ ts, ltp })
  }

  const cutoff = ts - MAX_WATCHLIST_HISTORY_MS
  let start = 0
  while (start < next.length && next[start].ts < cutoff) start += 1
  return start > 0 ? next.slice(start) : next
}

export function priceAtOrBefore(samples: PriceSample[], targetTs: number): number | null {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index].ts <= targetTs) return samples[index].ltp
  }
  return null
}

export function percentChangeFromHistory(
  samples: PriceSample[],
  currentLtp: number,
  lookbackMs: number,
  now = Date.now(),
): number | null {
  if (!Number.isFinite(currentLtp) || currentLtp <= 0 || samples.length === 0) return null
  const past = priceAtOrBefore(samples, now - lookbackMs)
  if (past == null || past <= 0) return null
  return Math.round(((currentLtp - past) / past) * 10000) / 100
}

export function computeWindowChanges(
  samples: PriceSample[],
  currentLtp: number,
  now = Date.now(),
): Record<WatchlistChangeWindowId, number | null> {
  const result = {} as Record<WatchlistChangeWindowId, number | null>
  for (const window of WATCHLIST_CHANGE_WINDOWS) {
    result[window.id] = percentChangeFromHistory(samples, currentLtp, window.ms, now)
  }
  return result
}
