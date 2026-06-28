export const US_MARKET_TZ = 'America/New_York'

export type MarketClockZoneId = 'new-york' | 'amsterdam' | 'mumbai'

export type MarketClockZone = {
  id: MarketClockZoneId
  label: string
  timeZone: string
  abbr: string
}

export const MARKET_CLOCK_ZONES: MarketClockZone[] = [
  { id: 'new-york', label: 'New York', timeZone: 'America/New_York', abbr: 'ET' },
  { id: 'amsterdam', label: 'Amsterdam', timeZone: 'Europe/Amsterdam', abbr: 'CET' },
  { id: 'mumbai', label: 'Mumbai', timeZone: 'Asia/Kolkata', abbr: 'IST' },
]

export const MARKET_CLOCK_STORAGE_KEY = 'minimal-ui-market-clock-zone'

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

type ClockParts = {
  weekday: number
  hour: number
  minute: number
  second: number
}

function clockParts(now: Date, timeZone: string): ClockParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now)

  const weekday = WEEKDAY_INDEX[parts.find(part => part.type === 'weekday')?.value ?? 'Mon'] ?? 1
  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? 0)
  const second = Number(parts.find(part => part.type === 'second')?.value ?? 0)

  return { weekday, hour, minute, second }
}

function minutesSinceMidnight(hour: number, minute: number): number {
  return hour * 60 + minute
}

export function loadMarketClockZone(): MarketClockZoneId {
  try {
    const stored = localStorage.getItem(MARKET_CLOCK_STORAGE_KEY)
    if (stored && MARKET_CLOCK_ZONES.some(zone => zone.id === stored)) {
      return stored as MarketClockZoneId
    }
  } catch {
    // ignore
  }
  return 'new-york'
}

export function saveMarketClockZone(zoneId: MarketClockZoneId) {
  try {
    localStorage.setItem(MARKET_CLOCK_STORAGE_KEY, zoneId)
  } catch {
    // ignore
  }
}

export function marketClockZoneById(zoneId: MarketClockZoneId): MarketClockZone {
  return MARKET_CLOCK_ZONES.find(zone => zone.id === zoneId) ?? MARKET_CLOCK_ZONES[0]
}

export function formatMarketDigitalClock(now: Date, timeZone: string): string {
  const { hour, minute, second } = clockParts(now, timeZone)
  return [hour, minute, second].map(value => String(value).padStart(2, '0')).join(':')
}

export type UsMarketSession = 'open' | 'pre' | 'after' | 'closed'

export function getUsMarketSession(now: Date = new Date()): UsMarketSession {
  const { weekday, hour, minute } = clockParts(now, US_MARKET_TZ)
  if (weekday === 0 || weekday === 6) return 'closed'

  const mins = minutesSinceMidnight(hour, minute)
  const preStart = 4 * 60
  const openStart = 9 * 60 + 30
  const openEnd = 16 * 60
  const afterEnd = 20 * 60

  if (mins >= openStart && mins < openEnd) return 'open'
  if (mins >= preStart && mins < openStart) return 'pre'
  if (mins >= openEnd && mins < afterEnd) return 'after'
  return 'closed'
}

export function formatUsMarketDigitalClock(now: Date = new Date()): string {
  return formatMarketDigitalClock(now, US_MARKET_TZ)
}

export function usMarketSessionLabel(session: UsMarketSession): string {
  switch (session) {
    case 'open':
      return 'Market open'
    case 'pre':
      return 'Pre-market'
    case 'after':
      return 'After-hours'
    default:
      return 'Market closed'
  }
}
