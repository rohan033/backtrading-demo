import type { EtoroPositionsResponse } from './etoro-account-data'

export type EtoroPositionRow = {
  rowKey: string
  /** Stable UI/bracket key — may be synthetic when broker id is missing. */
  positionId: string
  /** Verified eToro positionID from broker — required to close. */
  brokerPositionId: string | null
  tradingsymbol: string
  displayName: string | null
  symboltoken: string
  quantity: number
  openRate: number
  isBuy: boolean
  brokerLtp: number | null
  brokerPnl: number | null
  logo35x35?: string | null
  logo50x50?: string | null
  logo150x150?: string | null
  raw: Record<string, unknown>
}

function firstNumber(value: unknown): number | null {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function firstString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = row[key]
    if (value !== undefined && value !== null && String(value).trim()) {
      return String(value).trim()
    }
  }
  return ''
}

function readBrokerPnl(raw: Record<string, unknown>): number | null {
  const unrealized = raw.unrealizedPnL
  if (unrealized && typeof unrealized === 'object') {
    return firstNumber((unrealized as Record<string, unknown>).pnL)
  }
  return firstNumber(unrealized)
}

function readBrokerMark(raw: Record<string, unknown>): number | null {
  const unrealized = raw.unrealizedPnL
  if (unrealized && typeof unrealized === 'object') {
    const nested = unrealized as Record<string, unknown>
    const closeRate = firstNumber(nested.closeRate ?? nested.CloseRate)
    if (closeRate != null && closeRate > 0) return closeRate
  }
  return firstNumber(raw.currentRate ?? raw.CurrentRate ?? raw.lastRate ?? raw.LastRate)
}

export function resolveBrokerPositionId(
  raw: Record<string, unknown>,
  row: Record<string, unknown>,
  symboltoken: string,
): string | null {
  const id = firstString(
    raw,
    'positionID',
    'positionId',
    'PositionID',
    'position_id',
  ) || firstString(row, 'position_id', 'positionId', 'positionID')
  if (!id || id.includes(':')) return null
  if (symboltoken && id === symboltoken) return null
  return id
}

export function isVerifiedBrokerPositionId(row: EtoroPositionRow): boolean {
  return Boolean(row.brokerPositionId)
}

export type ClosedPositionRef = {
  rowKey?: string
  brokerPositionId?: string | null
}

export function matchesClosedPosition(
  row: EtoroPositionRow,
  closed: ClosedPositionRef,
): boolean {
  if (closed.rowKey && row.rowKey === closed.rowKey) return true
  const pid = closed.brokerPositionId?.trim()
  if (!pid) return false
  return row.brokerPositionId === pid || row.positionId === pid
}

export function normalizeEtoroPositions(response: EtoroPositionsResponse): EtoroPositionRow[] {
  const rows = response.data || []
  const rawRows = response.raw || []
  const out: EtoroPositionRow[] = []

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as Record<string, unknown>
    const raw = (rawRows[i] as Record<string, unknown> | undefined) || row
    const symboltoken = String(row.symboltoken || raw.instrumentID || raw.instrumentId || '')
    const quantity = firstNumber(row.quantity ?? raw.units ?? raw.Units) || 0
    const openRate = firstNumber(row.averageprice ?? raw.openRate ?? raw.OpenRate) || 0
    const brokerLtp = readBrokerMark(raw) ?? firstNumber(row.ltp)
    const isBuy = raw.isBuy !== false && raw.IsBuy !== false
    const brokerPositionId = resolveBrokerPositionId(raw, row, symboltoken)
    const rowKey = brokerPositionId
      || `${symboltoken}:${openRate}:${quantity}:${isBuy ? 'buy' : 'sell'}:${i}`

    out.push({
      rowKey,
      positionId: brokerPositionId || rowKey,
      brokerPositionId,
      tradingsymbol: String(row.tradingsymbol || raw.symbol || symboltoken || rowKey),
      displayName: String(row.symbol || row.instrument_display_name || '').trim() || null,
      symboltoken,
      quantity,
      openRate,
      isBuy,
      brokerLtp,
      brokerPnl: readBrokerPnl(raw),
      logo35x35: row.logo35x35 as string | null | undefined,
      logo50x50: row.logo50x50 as string | null | undefined,
      logo150x150: row.logo150x150 as string | null | undefined,
      raw,
    })
  }

  return out
}

export function positionLivePnl(
  row: EtoroPositionRow,
  livePrice: number | null | undefined,
): { pnl: number; pnlPct: number; currentRate: number } | null {
  const rate = livePrice ?? row.brokerLtp
  if (rate == null || !(rate > 0) || !(row.openRate > 0) || !(row.quantity > 0)) return null
  const direction = row.isBuy ? 1 : -1
  const pnl = (rate - row.openRate) * row.quantity * direction
  const pnlPct = ((rate - row.openRate) / row.openRate) * 100 * direction
  return { pnl, pnlPct, currentRate: rate }
}
