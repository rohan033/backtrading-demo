export type TradeHalt = {
  id: string
  symbol: string
  issue_name?: string | null
  market?: string | null
  reason_code?: string | null
  pause_threshold_price?: string | null
  halt_date?: string | null
  halt_time?: string | null
  resumption_date?: string | null
  resumption_quote_time?: string | null
  resumption_trade_time?: string | null
  pub_date?: string | null
  status: 'halted' | 'resumed' | string
  halt_day: string
  first_seen_at?: string
  updated_at?: string
  notify_enabled?: boolean
}

export type TradeHaltNotification = {
  id: string
  halt_id: string
  symbol: string
  event_type: 'halted' | 'resumed' | string
  headline: string
  dismissed?: boolean
  created_at: string
  payload?: TradeHalt | null
}

export type HotHaltSymbol = {
  symbol: string
  issue_name?: string | null
  halt_count: number
  halted_count: number
  resumed_count: number
  last_status: string
  last_halt_day?: string | null
  reason_code?: string
}

export async function fetchTradeHaltsForDay(
  day?: string | null,
  reason: string | null = 'LUDP',
): Promise<{ day: string | null; data: TradeHalt[] }> {
  const params = new URLSearchParams()
  if (day) params.set('day', day)
  if (reason) params.set('reason', reason)
  const qs = params.toString()
  const res = await fetch(`/api/trade-halts${qs ? `?${qs}` : ''}`)
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to load trade halts')
  }
  const payload = (await res.json()) as { day?: string | null; data?: TradeHalt[] }
  return {
    day: payload.day ?? day ?? null,
    data: Array.isArray(payload.data) ? payload.data : [],
  }
}

export async function deleteOlderTradeHalts(keepDay?: string | null): Promise<{
  keep_day: string
  halts_deleted: number
  notifications_deleted: number
}> {
  const qs = keepDay ? `?keep_day=${encodeURIComponent(keepDay)}` : ''
  const res = await fetch(`/api/trade-halts/older${qs}`, { method: 'DELETE' })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to delete older halts')
  }
  return (await res.json()) as {
    keep_day: string
    halts_deleted: number
    notifications_deleted: number
  }
}

/** Rank symbols by halt frequency from an already-loaded list. */
export function rankHotHaltSymbols(halts: TradeHalt[], limit = 6): HotHaltSymbol[] {
  const counts = new Map<string, HotHaltSymbol & { _recency: number }>()
  for (const row of halts) {
    const symbol = (row.symbol || '').trim().toUpperCase()
    if (!symbol) continue
    let bucket = counts.get(symbol)
    if (!bucket) {
      bucket = {
        symbol,
        issue_name: row.issue_name,
        halt_count: 0,
        halted_count: 0,
        resumed_count: 0,
        last_status: row.status || 'halted',
        last_halt_day: row.halt_day,
        reason_code: row.reason_code || undefined,
        _recency: haltRecencyScore(row),
      }
      counts.set(symbol, bucket)
    }
    bucket.halt_count += 1
    const rowStatus = String(row.status || '').toLowerCase()
    if (rowStatus === 'resumed') {
      bucket.resumed_count += 1
    } else {
      bucket.halted_count += 1
    }
    const recency = haltRecencyScore(row)
    if (recency >= bucket._recency) {
      bucket._recency = recency
      bucket.last_halt_day = row.halt_day
      bucket.last_status = rowStatus === 'resumed' ? 'resumed' : 'halted'
      if (row.issue_name) bucket.issue_name = row.issue_name
    }
  }
  const ranked = [...counts.values()]
    .sort(
      (a, b) =>
        b.halt_count - a.halt_count ||
        a.symbol.localeCompare(b.symbol),
    )
  const active = ranked.filter(item => item.last_status === 'halted')
  const pool = active.length ? active : ranked
  return pool
    .slice(0, Math.max(1, Math.min(limit, 20)))
    .map(({ _recency, ...item }) => item)
}

function haltRecencyScore(row: TradeHalt): number {
  const day = String(row.halt_day || row.halt_date || '').trim()
  const match = String(row.halt_date || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  let ms = day ? Date.parse(`${day}T00:00:00Z`) || 0 : 0
  if (match) {
    const month = Number(match[1])
    const dayNum = Number(match[2])
    const year = Number(match[3])
    const clean = String(row.halt_time || '00:00:00').trim().split('.')[0]
    const [hh = '0', mm = '0', ss = '0'] = clean.split(':')
    ms = Math.max(
      ms,
      new Date(year, month - 1, dayNum, Number(hh) || 0, Number(mm) || 0, Number(ss) || 0).getTime(),
    )
  }
  return ms
}

export async function fetchTradeHaltNotifySettings(): Promise<{
  notifications_enabled: boolean
  tickers: Array<{ symbol: string; notify_enabled: boolean; updated_at?: string }>
}> {
  const res = await fetch('/api/trade-halts/notify-prefs')
  if (!res.ok) {
    return { notifications_enabled: true, tickers: [] }
  }
  const payload = (await res.json()) as {
    notifications_enabled?: boolean
    data?: Array<{ symbol: string; notify_enabled: boolean; updated_at?: string }>
  }
  return {
    notifications_enabled: payload.notifications_enabled !== false,
    tickers: Array.isArray(payload.data) ? payload.data : [],
  }
}

export async function setTradeHaltGlobalNotifyEnabled(enabled: boolean): Promise<void> {
  const res = await fetch('/api/trade-halts/notify-prefs/global', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to update global notification preference')
  }
}

export async function setTradeHaltNotifyEnabled(symbol: string, enabled: boolean): Promise<void> {
  const res = await fetch(`/api/trade-halts/notify-prefs/${encodeURIComponent(symbol)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to update notification preference')
  }
}

export async function fetchTradeHaltNotifications(limit = 50): Promise<TradeHaltNotification[]> {
  const res = await fetch(`/api/trade-halts/notifications?limit=${limit}`)
  if (!res.ok) return []
  const payload = (await res.json()) as { data?: TradeHaltNotification[] }
  return Array.isArray(payload.data) ? payload.data : []
}

export async function dismissTradeHaltNotification(id: string): Promise<void> {
  const res = await fetch(`/api/trade-halts/notifications/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to dismiss notification')
  }
}

export async function dismissAllTradeHaltNotifications(): Promise<void> {
  const res = await fetch('/api/trade-halts/notifications', { method: 'DELETE' })
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detail?: string }
    throw new Error(payload.detail || 'Failed to clear notifications')
  }
}
