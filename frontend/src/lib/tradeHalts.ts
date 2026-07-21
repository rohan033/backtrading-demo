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

export async function fetchTradeHaltsForDay(day?: string | null): Promise<{ day: string | null; data: TradeHalt[] }> {
  const qs = day ? `?day=${encodeURIComponent(day)}` : ''
  const res = await fetch(`/api/trade-halts${qs}`)
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
