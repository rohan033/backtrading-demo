import { US_MARKET_TZ } from './marketClock'

export type ChartSessionMarket = 'US' | 'NSE'
export type ChartSessionKind = 'closed' | 'pre' | 'open' | 'after'

export type ChartSessionBand = {
  fromTime: number
  toTime: number
  session: ChartSessionKind
}

type WallParts = {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function wallParts(date: Date, timeZone: string): WallParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)

  return {
    weekday: WEEKDAY_INDEX[parts.find(part => part.type === 'weekday')?.value ?? 'Mon'] ?? 1,
    year: Number(parts.find(part => part.type === 'year')?.value ?? 0),
    month: Number(parts.find(part => part.type === 'month')?.value ?? 0),
    day: Number(parts.find(part => part.type === 'day')?.value ?? 0),
    hour: Number(parts.find(part => part.type === 'hour')?.value ?? 0),
    minute: Number(parts.find(part => part.type === 'minute')?.value ?? 0),
  }
}

function compareWall(a: WallParts, b: Omit<WallParts, 'weekday'>): number {
  if (a.year !== b.year) return a.year - b.year
  if (a.month !== b.month) return a.month - b.month
  if (a.day !== b.day) return a.day - b.day
  if (a.hour !== b.hour) return a.hour - b.hour
  return a.minute - b.minute
}

export function zonedWallTimeToUnix(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const target = { year, month, day, hour, minute }
  let low = Date.UTC(year, month - 1, day, hour, minute) - 36 * 3_600_000
  let high = Date.UTC(year, month - 1, day, hour, minute) + 36 * 3_600_000

  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    const parts = wallParts(new Date(mid), timeZone)
    const cmp = compareWall(parts, target)
    if (cmp < 0) low = mid + 1
    else high = mid
  }

  return Math.floor(low / 1000)
}

function isWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5
}

function usSessionsForDay(year: number, month: number, day: number, weekday: number): ChartSessionBand[] {
  if (!isWeekday(weekday)) {
    const start = zonedWallTimeToUnix(year, month, day, 0, 0, US_MARKET_TZ)
    const end = start + 86_400
    return [{ fromTime: start, toTime: end, session: 'closed' }]
  }

  const dayStart = zonedWallTimeToUnix(year, month, day, 0, 0, US_MARKET_TZ)
  const preStart = zonedWallTimeToUnix(year, month, day, 4, 0, US_MARKET_TZ)
  const openStart = zonedWallTimeToUnix(year, month, day, 9, 30, US_MARKET_TZ)
  const openEnd = zonedWallTimeToUnix(year, month, day, 16, 0, US_MARKET_TZ)
  const afterEnd = zonedWallTimeToUnix(year, month, day, 20, 0, US_MARKET_TZ)
  const dayEnd = dayStart + 86_400

  return [
    { fromTime: dayStart, toTime: preStart, session: 'closed' },
    { fromTime: preStart, toTime: openStart, session: 'pre' },
    { fromTime: openStart, toTime: openEnd, session: 'open' },
    { fromTime: openEnd, toTime: afterEnd, session: 'after' },
    { fromTime: afterEnd, toTime: dayEnd, session: 'closed' },
  ]
}

export const NSE_MARKET_TZ = 'Asia/Kolkata'

export function chartMarketTimeZone(market: ChartSessionMarket): string {
  return market === 'US' ? US_MARKET_TZ : NSE_MARKET_TZ
}

export function chartMarketTimeFormatter(market: ChartSessionMarket) {
  const timeZone = chartMarketTimeZone(market)
  return (time: number) =>
    new Date(time * 1000).toLocaleString('en-US', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
}

function nseSessionsForDay(year: number, month: number, day: number, weekday: number): ChartSessionBand[] {
  const dayStart = zonedWallTimeToUnix(year, month, day, 0, 0, NSE_MARKET_TZ)
  const dayEnd = dayStart + 86_400

  if (!isWeekday(weekday)) {
    return [{ fromTime: dayStart, toTime: dayEnd, session: 'closed' }]
  }

  const preStart = zonedWallTimeToUnix(year, month, day, 9, 0, NSE_MARKET_TZ)
  const openStart = zonedWallTimeToUnix(year, month, day, 9, 15, NSE_MARKET_TZ)
  const openEnd = zonedWallTimeToUnix(year, month, day, 15, 30, NSE_MARKET_TZ)

  return [
    { fromTime: dayStart, toTime: preStart, session: 'closed' },
    { fromTime: preStart, toTime: openStart, session: 'pre' },
    { fromTime: openStart, toTime: openEnd, session: 'open' },
    { fromTime: openEnd, toTime: dayEnd, session: 'closed' },
  ]
}

function collectDaysInRange(fromTime: number, toTime: number, timeZone: string): WallParts[] {
  const seen = new Set<string>()
  const days: WallParts[] = []
  const step = 6 * 3_600
  for (let t = fromTime; t <= toTime + 86_400; t += step) {
    const parts = wallParts(new Date(t * 1000), timeZone)
    const key = `${parts.year}-${parts.month}-${parts.day}`
    if (seen.has(key)) continue
    seen.add(key)
    days.push(parts)
  }
  return days
}

export function buildChartSessionBands(
  fromTime: number,
  toTime: number,
  market: ChartSessionMarket,
): ChartSessionBand[] {
  if (!Number.isFinite(fromTime) || !Number.isFinite(toTime) || toTime <= fromTime) {
    return []
  }

  const timeZone = market === 'US' ? US_MARKET_TZ : NSE_MARKET_TZ
  const buildDay = market === 'US' ? usSessionsForDay : nseSessionsForDay
  const bands: ChartSessionBand[] = []

  for (const day of collectDaysInRange(fromTime, toTime, timeZone)) {
    for (const band of buildDay(day.year, day.month, day.day, day.weekday)) {
      const start = Math.max(band.fromTime, fromTime)
      const end = Math.min(band.toTime, toTime + 60)
      if (end > start) bands.push({ ...band, fromTime: start, toTime: end })
    }
  }

  return bands
}

export function chartSessionMarketForBroker(broker: string): ChartSessionMarket {
  return broker === 'angel' ? 'NSE' : 'US'
}

export function chartSessionLabel(session: ChartSessionKind): string {
  switch (session) {
    case 'pre':
      return 'Pre-market'
    case 'open':
      return 'Regular'
    case 'after':
      return 'After-hours'
    default:
      return 'Closed'
  }
}
