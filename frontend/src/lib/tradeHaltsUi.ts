import type { TradeHalt } from './tradeHalts'
import { zonedWallTimeToUnix } from './homeChartSessionShading'
import { US_MARKET_TZ } from './marketClock'

export const NASDAQ_RESUME_OFFSET_MIN = 5
export const LUDP_HALT_CYCLE_MS = NASDAQ_RESUME_OFFSET_MIN * 60 * 1000
export const LUDP_HALT_GAP_MS = 5000

export type LudpHaltTimerPhase = 'countdown' | 'gap'

export type LudpHaltTimerState = {
  phase: LudpHaltTimerPhase
  cycle: number
  remainingMs: number
  progressPct: number
  label: string
}

function parseNasdaqDateParts(datePart: string | null | undefined): { y: number; m: number; d: number } | null {
  const match = String(datePart || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  const year = Number(match[3])
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(year)) return null
  return { y: year, m: month, d: day }
}

function parseNasdaqTimeParts(timePart: string | null | undefined): { h: number; min: number; s: number; ms: number } {
  const raw = String(timePart || '00:00:00').trim()
  const [main, frac = ''] = raw.split('.')
  const [hh = '0', mm = '0', ss = '0'] = main.split(':')
  const msRaw = frac.replace(/[^\d]/g, '').slice(0, 3)
  return {
    h: Number(hh) || 0,
    min: Number(mm) || 0,
    s: Number(ss) || 0,
    ms: msRaw ? Number(msRaw.padEnd(3, '0')) : 0,
  }
}

/** Nasdaq MM/DD/YYYY + HH:MM:SS[.fff] as US/Eastern wall clock → epoch ms. */
export function nasdaqMarketDateTimeToMs(
  datePart: string | null | undefined,
  timePart: string | null | undefined,
): number | null {
  const date = parseNasdaqDateParts(datePart)
  if (!date) return null
  const time = parseNasdaqTimeParts(timePart)
  const baseSec = zonedWallTimeToUnix(date.y, date.m, date.d, time.h, time.min, US_MARKET_TZ)
  return baseSec * 1000 + time.s * 1000 + time.ms
}

function formatNasdaqWallClock(date: { y: number; m: number; d: number }, time: { h: number; min: number; s: number }): string {
  const stamp = new Date(date.y, date.m - 1, date.d, time.h, time.min, time.s)
  const dateLabel = stamp.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })
  const timeLabel = stamp.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: time.s ? '2-digit' : undefined,
  })
  return `${dateLabel} ${timeLabel} ET`
}

/** Wall-clock ET label for a Nasdaq halt/resume date+time pair. */
export function formatNasdaqMarketTime(
  datePart: string | null | undefined,
  timePart: string | null | undefined,
): string | null {
  const date = parseNasdaqDateParts(datePart)
  if (!date) return null
  return formatNasdaqWallClock(date, parseNasdaqTimeParts(timePart))
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(totalSec / 60)
  const seconds = totalSec % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function haltStartedAtMs(halt: TradeHalt): number | null {
  return nasdaqMarketDateTimeToMs(halt.halt_date, halt.halt_time)
}

/** Rolling 5-minute LUDP resume window with a 5s gap between cycles. */
export function computeLudpHaltTimer(
  halt: TradeHalt,
  nowMs: number = Date.now(),
): LudpHaltTimerState | null {
  if (String(halt.status || '').toLowerCase() !== 'halted') return null
  const startedMs = haltStartedAtMs(halt)
  if (startedMs == null || !Number.isFinite(startedMs)) return null

  const blockMs = LUDP_HALT_CYCLE_MS + LUDP_HALT_GAP_MS
  const elapsedMs = Math.max(0, nowMs - startedMs)
  const cycleIndex = Math.floor(elapsedMs / blockMs)
  const inBlockMs = elapsedMs % blockMs

  if (inBlockMs < LUDP_HALT_CYCLE_MS) {
    const remainingMs = LUDP_HALT_CYCLE_MS - inBlockMs
    return {
      phase: 'countdown',
      cycle: cycleIndex + 1,
      remainingMs,
      progressPct: (remainingMs / LUDP_HALT_CYCLE_MS) * 100,
      label: formatCountdown(remainingMs),
    }
  }

  const gapRemainingMs = blockMs - inBlockMs
  return {
    phase: 'gap',
    cycle: cycleIndex + 1,
    remainingMs: gapRemainingMs,
    progressPct: ((LUDP_HALT_GAP_MS - gapRemainingMs) / LUDP_HALT_GAP_MS) * 100,
    label: `Next ${NASDAQ_RESUME_OFFSET_MIN}m in ${Math.max(1, Math.ceil(gapRemainingMs / 1000))}s`,
  }
}

export function formatEpochMsNasdaqEt(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_MARKET_TZ,
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms))
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')}/${pick('year')} ${pick('hour')}:${pick('minute')}:${pick('second')} ET`
}

/** End of the current (or next) LUDP 5m resume window, or published resumption time. */
export function computeLudpProbableOpenMs(halt: TradeHalt, nowMs: number = Date.now()): number | null {
  if ((halt.resumption_trade_time || '').trim()) {
    return nasdaqMarketDateTimeToMs(halt.resumption_date, halt.resumption_trade_time)
  }
  const timer = computeLudpHaltTimer(halt, nowMs)
  if (!timer) return null
  if (timer.phase === 'countdown') return nowMs + timer.remainingMs
  return nowMs + timer.remainingMs + LUDP_HALT_CYCLE_MS
}

export function formatProbableOpenTime(halt: TradeHalt, nowMs: number = Date.now()): string {
  const ms = computeLudpProbableOpenMs(halt, nowMs)
  if (ms == null) return '—'
  return formatEpochMsNasdaqEt(ms)
}

export function estimateHaltResumeLabel(halt: TradeHalt): string {
  const published = formatNasdaqMarketTime(halt.resumption_date, halt.resumption_trade_time)
  if (published) return `Resume ~${published}`

  const date = parseNasdaqDateParts(halt.halt_date)
  if (!date) return `Est. resume ~+${NASDAQ_RESUME_OFFSET_MIN} min (Nasdaq LUDP)`

  const startedMs = nasdaqMarketDateTimeToMs(halt.halt_date, halt.halt_time)
  if (startedMs == null) return `Est. resume ~+${NASDAQ_RESUME_OFFSET_MIN} min (Nasdaq LUDP)`
  const estMs = startedMs + NASDAQ_RESUME_OFFSET_MIN * 60 * 1000
  const estDate = new Date(estMs)
  const estParts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_MARKET_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  }).formatToParts(estDate)
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    estParts.find(part => part.type === type)?.value ?? ''
  return `Est. resume ~${pick('month')}/${pick('day')}/${pick('year')} ${pick('hour')}:${pick('minute')}:${pick('second')} ${pick('dayPeriod')} ET (+${NASDAQ_RESUME_OFFSET_MIN} min)`
}

export function haltedSymbolTitle(halt: TradeHalt): string {
  return `Halted · ${estimateHaltResumeLabel(halt)}`
}

function haltRecencyScore(halt: TradeHalt): number {
  const day = String(halt.halt_day || halt.halt_date || '').trim()
  const ms = nasdaqMarketDateTimeToMs(halt.halt_date, halt.halt_time) ?? 0
  const dayScore = day ? Date.parse(`${day}T00:00:00Z`) || 0 : 0
  return Math.max(dayScore, ms)
}

/** Latest halt row per symbol (for settings table). */
export function latestHaltPerSymbol(halts: TradeHalt[]): TradeHalt[] {
  const map = new Map<string, TradeHalt>()
  for (const halt of halts) {
    const symbol = String(halt.symbol || '').trim().toUpperCase()
    if (!symbol) continue
    const prev = map.get(symbol)
    if (!prev || haltRecencyScore(halt) >= haltRecencyScore(prev)) {
      map.set(symbol, halt)
    }
  }
  return [...map.values()].sort(
    (a, b) => haltRecencyScore(b) - haltRecencyScore(a) || a.symbol.localeCompare(b.symbol),
  )
}

/** Latest row per symbol that is still actively halted (empty resumption trade time). */
export function currentlyHaltedHalts(halts: TradeHalt[]): TradeHalt[] {
  return latestHaltPerSymbol(halts).filter(
    halt => String(halt.status || '').toLowerCase() === 'halted',
  )
}

/** Latest actively halted row per ticker symbol. */
export function buildHaltedBySymbol(halts: TradeHalt[]): Map<string, TradeHalt> {
  const map = new Map<string, TradeHalt>()
  for (const halt of halts) {
    if (String(halt.status || '').toLowerCase() !== 'halted') continue
    const symbol = String(halt.symbol || '').trim().toUpperCase()
    if (!symbol) continue
    const prev = map.get(symbol)
    if (!prev || haltRecencyScore(halt) >= haltRecencyScore(prev)) {
      map.set(symbol, halt)
    }
  }
  return map
}

export function lookupHaltedSymbol(
  haltedBySymbol: Map<string, TradeHalt>,
  ticker: string | null | undefined,
): TradeHalt | undefined {
  const symbol = String(ticker || '').trim().toUpperCase()
  if (!symbol) return undefined
  return haltedBySymbol.get(symbol)
}
