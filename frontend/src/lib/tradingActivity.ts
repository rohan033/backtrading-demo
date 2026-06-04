import { normalizeSymbolKey } from './groupExecutionsBySymbol'

export type ActivityItem = {
  type: 'buy' | 'sell' | 'pending' | 'info'
  title: string
  detail: string
  time: string
}

export function formatRelativeTime(event: Record<string, unknown>): string {
  const raw = event.created_at || event.received_at || event.timestamp
  if (!raw) return '—'
  const date = typeof raw === 'number' ? new Date(raw * 1000) : new Date(String(raw))
  if (Number.isNaN(date.getTime())) return '—'
  const deltaMs = Date.now() - date.getTime()
  const minutes = Math.floor(deltaMs / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return date.toLocaleDateString()
}

function getEventAction(event: Record<string, unknown>): string {
  return String(
    event.action || event.activity_type || event.event_type || event.type || 'EVENT',
  ).toUpperCase()
}

export function mapEventToActivity(event: Record<string, unknown>): ActivityItem {
  const action = getEventAction(event)
  const details = (event.details || event.content || {}) as Record<string, unknown>
  const symbol = String(event.symbol || details.symbol || '').trim()

  let type: ActivityItem['type'] = 'info'
  if (action.includes('BUY') || (action.includes('FILLED') && !action.includes('SELL'))) type = 'buy'
  else if (
    action.includes('SELL')
    || action.includes('CLOSE')
    || action.includes('TAKE_PROFIT')
    || action.includes('STOP_LOSS')
  ) {
    type = 'sell'
  } else if (action.includes('PENDING')) type = 'pending'

  const titleParts = [action.replace(/_/g, ' ').toLowerCase()]
  if (symbol) titleParts.push(`· ${symbol}`)

  const detailParts = [
    details.quantity && details.price ? `${details.quantity} units @ ${details.price}` : '',
    event.order_id ? `order ${event.order_id}` : '',
    details.message ? String(details.message) : '',
    details.reason ? String(details.reason) : '',
  ].filter(Boolean)

  return {
    type,
    title: titleParts.join(' '),
    detail: detailParts.join(' · ') || 'Strategy event',
    time: formatRelativeTime(event),
  }
}

export function mergeActivityEvents(
  realtimeEvents: Record<string, unknown>[],
  persistedEvents: Record<string, unknown>[],
  {
    executorId,
    symbolKey,
    limit = 20,
  }: {
    executorId?: string | null
    symbolKey?: string | null
    limit?: number
  } = {},
): ActivityItem[] {
  const seen = new Set<string>()

  return [...realtimeEvents, ...persistedEvents]
    .filter(event => {
      const execId = String(event.executor_id || (event.details as Record<string, unknown> | undefined)?.executor_id || '')
      const details = (event.details || {}) as Record<string, unknown>
      const eventSymbol = String(event.symbol || details.symbol || '').trim()

      if (executorId && execId && execId !== executorId) return false
      if (
        symbolKey
        && eventSymbol
        && normalizeSymbolKey(eventSymbol) !== normalizeSymbolKey(symbolKey)
      ) {
        return false
      }

      const key = `${event.id || ''}-${event.timestamp || event.created_at || ''}-${event.action}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, limit)
    .map(mapEventToActivity)
}
