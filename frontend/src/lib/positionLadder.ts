import { formatApiError } from './apiError'

export type PositionLadderLevel = {
  id: string
  price: number
  fraction: number
  gain_fraction?: number
  label: string
  hit?: boolean
}

export const LADDER_TRIM_FRACTION = 0.25

/** Profit if this rung trims 25% of original size at the rung price (whole units, rounded up). */
export function ladderLevelEstProfit(
  level: PositionLadderLevel,
  entryPrice: number,
  entryUnits: number,
  isBuy: boolean,
): number | null {
  if (!(entryPrice > 0) || !(entryUnits > 0) || !(level.price > 0)) return null
  const fraction = level.fraction > 0 ? level.fraction : LADDER_TRIM_FRACTION
  const trimUnits = Math.ceil(entryUnits * fraction - 1e-9)
  const direction = isBuy ? 1 : -1
  return (level.price - entryPrice) * trimUnits * direction
}

export type LadderProfitSummary = {
  secured: number
  unrealized: number
  total: number
}

/** Secured trim profits + mark-to-market on the remaining slice. */
export function ladderOverallProfit(
  ladder: PositionLadderState,
  liveMark?: number | null,
): LadderProfitSummary | null {
  const entry = ladder.entry_price
  const units = ladder.entry_units
  if (entry == null || units == null || !(entry > 0) || !(units > 0)) return null

  const isBuy = ladder.is_buy !== false
  const direction = isBuy ? 1 : -1
  const remainingUnits = Math.max(0, Math.ceil(units * (ladder.remaining_fraction ?? 1) - 1e-9))
  const mark = liveMark ?? ladder.live_price ?? ladder.peak_price ?? entry

  let secured = 0
  for (const level of ladder.levels ?? []) {
    if (!level.hit) continue
    const slice = ladderLevelEstProfit(level, entry, units, isBuy)
    if (slice != null) secured += slice
  }

  const unrealized = (mark - entry) * remainingUnits * direction
  return { secured, unrealized, total: secured + unrealized }
}

export type PositionLadderState = {
  account_env: string
  broker_position_id: string
  ticker: string
  instrument_id?: number | null
  auto_ladder_enabled: boolean
  is_buy: boolean
  entry_price: number | null
  entry_units: number | null
  remaining_fraction: number
  peak_price: number | null
  l1_hit: boolean
  l2_hit: boolean
  l3_hit: boolean
  last_hit_price: number | null
  levels: PositionLadderLevel[]
  updated_at?: string | null
  live_price?: number | null
  next_level?: PositionLadderLevel | null
  active?: boolean
}

async function parseJson<T>(res: Response): Promise<T> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    if (!res.ok) throw new Error(res.statusText || 'Request failed')
    throw new Error('Invalid response from server')
  }
  const payload = body as { status?: boolean; data?: T }
  if (!res.ok || payload.status === false) {
    throw new Error(formatApiError(body, res.statusText || 'Request failed'))
  }
  return payload.data as T
}

export async function fetchPositionLadderStates(
  accountEnv: 'demo' | 'live',
): Promise<PositionLadderState[]> {
  const params = new URLSearchParams({ account_env: accountEnv })
  return parseJson(
    await fetch(`/api/control/position-ladder?${params}`),
  )
}

export async function setPositionAutoLadder(
  accountEnv: 'demo' | 'live',
  brokerPositionId: string,
  body: {
    enabled: boolean
    ticker: string
    instrument_id?: number | null
    entry_price?: number | null
    entry_units?: number | null
    is_buy?: boolean
  },
): Promise<PositionLadderState> {
  const params = new URLSearchParams({ account_env: accountEnv })
  return parseJson(
    await fetch(
      `/api/control/position-ladder/${encodeURIComponent(brokerPositionId)}?${params}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  )
}

export async function resetPositionLadder(
  accountEnv: 'demo' | 'live',
  brokerPositionId: string,
  body: {
    ticker: string
    entry_price?: number | null
    entry_units?: number | null
    peak_price?: number | null
  },
): Promise<PositionLadderState> {
  const params = new URLSearchParams({ account_env: accountEnv })
  return parseJson(
    await fetch(
      `/api/control/position-ladder/${encodeURIComponent(brokerPositionId)}/reset?${params}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  )
}

export function ladderStateByPositionId(
  rows: PositionLadderState[],
): Record<string, PositionLadderState> {
  const out: Record<string, PositionLadderState> = {}
  for (const row of rows) {
    if (row.broker_position_id) out[row.broker_position_id] = row
  }
  return out
}
