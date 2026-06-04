import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { mergeActivityEvents, type ActivityItem } from '../lib/tradingActivity'

const CONTROL_API = '/api/control'

function ActivityRow({ item }: { item: ActivityItem }) {
  const iconStyle = item.type === 'buy'
    ? { background: 'rgba(0, 200, 83, 0.15)', color: '#00c853' }
    : item.type === 'sell'
      ? { background: 'rgba(255, 82, 82, 0.15)', color: '#ff5252' }
      : item.type === 'pending'
        ? { background: 'rgba(251, 191, 36, 0.15)', color: '#fbbf24' }
        : { background: 'rgba(29, 161, 242, 0.12)', color: '#1da1f2' }

  const icon = item.type === 'buy'
    ? '▲'
    : item.type === 'sell'
      ? '▼'
      : item.type === 'pending'
        ? '◷'
        : '●'

  return (
    <div className="flex gap-3 border-b border-border py-3 last:border-b-0">
      <div
        className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs"
        style={iconStyle}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold capitalize">{item.title}</div>
        {item.detail ? <div className="text-xs text-text-secondary">{item.detail}</div> : null}
        <div className="mt-0.5 text-[11px] text-text-secondary">{item.time}</div>
      </div>
    </div>
  )
}

export function TradingActivityFeed({
  title = 'Activity',
  viewAllHref = '/trade/activity',
  executorId,
  symbolKey,
  realtimeEvents = [],
  limit = 20,
  compactLimit = 8,
  className = '',
}: {
  title?: string
  viewAllHref?: string
  executorId?: string | null
  symbolKey?: string | null
  realtimeEvents?: Record<string, unknown>[]
  limit?: number
  compactLimit?: number
  className?: string
}) {
  const [persistedEvents, setPersistedEvents] = useState<Record<string, unknown>[]>([])

  useEffect(() => {
    const params = new URLSearchParams({ limit: String(limit) })
    if (executorId) params.set('executor_id', executorId)
    if (symbolKey) params.set('symbol', symbolKey)

    const endpoint = symbolKey && !executorId
      ? `${CONTROL_API}/trades?${params}`
      : `${CONTROL_API}/events?${params}`

    fetch(endpoint)
      .then(res => res.json())
      .then(data => {
        if (data.status) setPersistedEvents(data.data || [])
      })
      .catch(() => setPersistedEvents([]))
  }, [executorId, symbolKey, limit, realtimeEvents.length])

  const events = useMemo(
    () => mergeActivityEvents(realtimeEvents, persistedEvents, {
      executorId,
      symbolKey,
      limit: compactLimit,
    }),
    [realtimeEvents, persistedEvents, executorId, symbolKey, compactLimit],
  )

  return (
    <div className={`flex min-h-[280px] flex-col overflow-hidden rounded-lg border border-border bg-card ${className}`}>
      <div className="flex items-center justify-between border-b border-border px-4 py-3.5">
        <h3 className="text-[13px] font-semibold">{title}</h3>
        {viewAllHref ? (
          <Link to={viewAllHref} className="text-xs font-semibold text-accent hover:underline">
            View all
          </Link>
        ) : null}
      </div>
      <div className="flex-1 overflow-auto px-4 py-1">
        {events.length ? (
          events.map((item, index) => <ActivityRow key={`${item.title}-${index}`} item={item} />)
        ) : (
          <div className="py-8 text-center text-sm text-text-secondary">
            No recent activity for this {symbolKey ? 'stock' : 'strategy'} yet.
          </div>
        )}
      </div>
    </div>
  )
}
