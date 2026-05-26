import { formatDbTimestamp } from './datetime'

export type DefaultSchedule = {
  broker: string
  trading_day: string
  scheduled_start_at: string
  market_open_label: string
  timezone: string
}

export type TradingDayOption = {
  trading_day: string
  label: string
  scheduled_start_at: string
}

export type TradingDayOptions = {
  broker: string
  market_open_label: string
  timezone: string
  options: TradingDayOption[]
}

function normalizeBroker(broker: string): 'angel' | 'etoro' {
  return broker === 'etoro' ? 'etoro' : 'angel'
}

function formatTradingDayISO(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatPillLabel(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  })
}

function isWeekday(date: Date): boolean {
  const day = date.getDay()
  return day >= 1 && day <= 5
}

export function buildLocalTradingDayOptions(broker: string, count = 4): TradingDayOptions {
  const normalized = normalizeBroker(broker)
  const marketOpenLabel = normalized === 'etoro' ? 'CEST 3:30 PM' : 'IST 09:15'
  const options: TradingDayOption[] = []
  let cursor = new Date()
  cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate())

  while (options.length < count) {
    if (isWeekday(cursor)) {
      options.push({
        trading_day: formatTradingDayISO(cursor),
        label: options.length === 0 ? 'Next session' : formatPillLabel(cursor),
        scheduled_start_at: '',
      })
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  }

  return {
    broker: normalized,
    market_open_label: marketOpenLabel,
    timezone: normalized === 'etoro' ? 'Europe/Berlin' : 'Asia/Kolkata',
    options,
  }
}

export async function fetchDefaultSchedule(
  broker: string,
  useFakeClient = false,
): Promise<DefaultSchedule | null> {
  const params = new URLSearchParams({
    broker,
    use_fake_client: String(useFakeClient),
  })
  const res = await fetch(`/api/control/executions/default-schedule?${params.toString()}`)
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.status) return null
  return data.data as DefaultSchedule
}

export async function fetchTradingDayOptions(
  broker: string,
  useFakeClient = false,
  count = 4,
): Promise<TradingDayOptions | null> {
  const params = new URLSearchParams({
    broker,
    use_fake_client: String(useFakeClient),
    count: String(count),
  })
  const res = await fetch(`/api/control/executions/trading-day-options?${params.toString()}`)
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.status) return null
  return data.data as TradingDayOptions
}

export async function loadTradingDayOptions(
  broker: string,
  useFakeClient = false,
  count = 4,
): Promise<TradingDayOptions> {
  const remote = await fetchTradingDayOptions(broker, useFakeClient, count)
  if (remote?.options?.length) return remote
  return buildLocalTradingDayOptions(broker, count)
}

export function formatScheduledStart(value: string | null | undefined): string {
  if (!value) return '—'
  return formatDbTimestamp(value)
}

export function scheduleSummary(
  tradingDay: string | null | undefined,
  marketOpenLabel: string | null | undefined,
): string {
  if (!tradingDay) return 'Next trading day'
  const open = marketOpenLabel ? ` at ${marketOpenLabel}` : ''
  return `${tradingDay}${open}`
}
