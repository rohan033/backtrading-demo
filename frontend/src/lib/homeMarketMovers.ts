import {
  getUsMarketSession,
  US_MARKET_TZ,
  type UsMarketSession,
} from './marketClock'
import type { ScreenerResultRow } from './screenerApi'

export const HOME_MOVERS_PM_SCREENER = 'Stock Catalyst PM Movers'
export const HOME_MOVERS_AH_SCREENER = 'Stock Catalyst AH Movers'
export const HOME_MOVERS_HOT_SCREENER = 'Hot stocks'
export const HOME_MOVERS_TRENDING_SCREENER = 'Top trending'

export const HOME_MOVERS_REFRESH_SECONDS = 60
export const HOME_MOVERS_MAX_CARDS = 18

const STOCK_CATALYST_SOURCES = new Set([
  'stock_catalyst_nyse_pm',
  'stock_catalyst_nyse_ah',
])

export function isStockCatalystScreenerSource(sourceType?: string | null): boolean {
  return Boolean(sourceType && STOCK_CATALYST_SOURCES.has(sourceType))
}

function clockParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_MARKET_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const weekdayMap: Record<string, number> = {
    Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
  }
  const weekday = weekdayMap[parts.find(part => part.type === 'weekday')?.value ?? 'Mon'] ?? 1
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
  return { weekday, hour, minute }
}

export function homeMoversScreenerName(session: UsMarketSession, now = new Date()): string {
  if (session === 'pre') return HOME_MOVERS_PM_SCREENER
  if (session === 'after') return HOME_MOVERS_AH_SCREENER
  if (session === 'open') return HOME_MOVERS_HOT_SCREENER
  const { weekday, hour, minute } = clockParts(now)
  const mins = hour * 60 + minute
  if (weekday >= 1 && weekday <= 5 && mins < 4 * 60) {
    return HOME_MOVERS_AH_SCREENER
  }
  return HOME_MOVERS_AH_SCREENER
}

export function homeMoversSessionHeadline(session: UsMarketSession): string {
  switch (session) {
    case 'pre':
      return 'PRE-MARKET'
    case 'open':
      return 'MARKET OPEN'
    case 'after':
      return 'AFTER-HOURS'
    default:
      return 'MARKET CLOSED'
  }
}

export function homeMoversSession(now = new Date()): UsMarketSession {
  return getUsMarketSession(now)
}

export type HomeMoverMetrics = {
  pct: number | null
  price: number | null
  changeAbs: number | null
}

function parseNum(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function homeMoverMetrics(
  row: ScreenerResultRow,
  sourceType?: string | null,
): HomeMoverMetrics {
  if (isStockCatalystScreenerSource(sourceType)) {
    return {
      pct: parseNum(row.cells?.change_pct),
      price: parseNum(row.cells?.last_price),
      changeAbs: parseNum(row.cells?.change_abs),
    }
  }

  const pct = parseNum(row.cells?.change ?? row.cells?.premarket_change ?? row.cells?.postmarket_change)
  const price = parseNum(row.cells?.close ?? row.cells?.premarket_close ?? row.cells?.postmarket_close)
  let changeAbs = parseNum(row.cells?.change_abs ?? row.cells?.premarket_change_abs)
  if (changeAbs == null && pct != null && price != null && price !== 0) {
    changeAbs = price - (price / (1 + pct / 100))
  }
  return { pct, price, changeAbs }
}

export function homeMoverPctTone(pct: number | null): 'up' | 'down' | 'flat' | 'none' {
  if (pct == null || !Number.isFinite(pct)) return 'none'
  if (pct > 0) return 'up'
  if (pct < 0) return 'down'
  return 'flat'
}

export function formatHomeMoverPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

export function formatHomeMoverPrice(price: number | null): string {
  if (price == null || !Number.isFinite(price)) return '—'
  if (Math.abs(price) >= 1000) {
    return `$${price.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  }
  return `$${price.toFixed(price < 1 ? 4 : 2)}`
}

export function formatHomeMoverAbs(changeAbs: number | null): string {
  if (changeAbs == null || !Number.isFinite(changeAbs)) return '—'
  const sign = changeAbs > 0 ? '+' : changeAbs < 0 ? '−' : ''
  const abs = Math.abs(changeAbs)
  const digits = abs < 1 ? 4 : 2
  return `${sign}$${abs.toFixed(digits)}`
}

export function homeMoverPctArrow(
  current: number | null,
  previous: number | null | undefined,
): 'up' | 'down' | 'flat' | null {
  if (current == null || previous == null || !Number.isFinite(previous)) return null
  if (current > previous) return 'up'
  if (current < previous) return 'down'
  return 'flat'
}

export function sortHomeMoverRows(
  rows: ScreenerResultRow[],
  sourceType?: string | null,
): ScreenerResultRow[] {
  return [...rows].sort((a, b) => {
    const left = homeMoverMetrics(a, sourceType).pct ?? Number.NEGATIVE_INFINITY
    const right = homeMoverMetrics(b, sourceType).pct ?? Number.NEGATIVE_INFINITY
    return right - left
  })
}
