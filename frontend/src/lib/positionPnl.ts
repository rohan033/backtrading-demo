export type LivePnl = {
  pnl: number
  pnl_pct: number
  current_rate: number
}

export function computeLivePnl(
  position: {
    position?: Record<string, unknown>
    remaining_units?: number
  },
  livePrice: number | null | undefined,
): LivePnl | null {
  if (livePrice == null || !(livePrice > 0)) return null
  const pos = position.position || {}
  const opening = (pos.openingData || {}) as Record<string, unknown>
  const openRate = Number(opening.avgPrice ?? pos.openRate ?? pos.OpenRate ?? 0)
  const units = Number(position.remaining_units ?? pos.remainingUnits ?? pos.units ?? pos.Units ?? 0)
  if (!(openRate > 0) || !(units > 0)) return null
  const isBuy = pos.isBuy ?? pos.IsBuy ?? true
  const direction = isBuy ? 1 : -1
  const pnl = (livePrice - openRate) * units * direction
  const pnlPct = ((livePrice - openRate) / openRate) * 100 * direction
  return { pnl, pnl_pct: pnlPct, current_rate: livePrice }
}

export function formatPnl(value: number | null | undefined): string | null {
  if (value == null) return null
  const n = Number(value)
  const sign = n >= 0 ? '+' : ''
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function isOpenPosition(
  position: {
    state?: string
    position_id?: string | number
    position?: { state?: string }
  },
  closedIds: Set<string | number> = new Set(),
): boolean {
  const posId = position.position_id
  const state = position.state || position.position?.state || ''
  return state !== 'closed' && !closedIds.has(posId as string | number)
}
