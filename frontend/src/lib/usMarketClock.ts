export const US_MARKET_TZ = 'America/New_York'

export type UsMarketSession = 'open' | 'pre' | 'after' | 'closed'

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

type EtClockParts = {
  weekday: number
  hour: number
  minute: number
  second: number
}

function etClockParts(now: Date): EtClockParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: US_MARKET_TZ,
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

export function getUsMarketSession(now: Date = new Date()): UsMarketSession {
  const { weekday, hour, minute } = etClockParts(now)
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
  const { hour, minute, second } = etClockParts(now)
  return [hour, minute, second].map(value => String(value).padStart(2, '0')).join(':')
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
