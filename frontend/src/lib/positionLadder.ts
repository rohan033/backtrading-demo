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
export const DEFAULT_LADDER_GAIN_PCTS = [35, 60, 85] as const
export const DEFAULT_LADDER_TRIM_PCT = 25
export const LADDER_MAX_GAIN_FRACTION = 1
export const LADDER_DEFAULT_STEP = 0.25

export function inferLadderStep(fractions: number[]): number {
  if (fractions.length >= 2) {
    const step = fractions[fractions.length - 1] - fractions[fractions.length - 2]
    if (step > 0) return step
  }
  return LADDER_DEFAULT_STEP
}

/** Base configured rungs, then the same step through 100% of peak gain. */
export function extendedGainFractions(gainFractions?: number[] | null): number[] {
  const base = gainFractions?.length
    ? [...gainFractions.slice(0, 3)]
    : DEFAULT_LADDER_GAIN_PCTS.map(pct => pct / 100)
  while (base.length < 3) {
    base.push(DEFAULT_LADDER_GAIN_PCTS[base.length] / 100)
  }
  const step = inferLadderStep(base)
  const out = [...base]
  while (out[out.length - 1] < LADDER_MAX_GAIN_FRACTION - 1e-9) {
    const next = Math.round((out[out.length - 1] + step) * 1_000_000) / 1_000_000
    if (next >= LADDER_MAX_GAIN_FRACTION) {
      out.push(LADDER_MAX_GAIN_FRACTION)
      break
    }
    out.push(next)
  }
  return out
}

export function parseLadderGainPcts(values: string[] | undefined): number[] {
  const fallback = [...DEFAULT_LADDER_GAIN_PCTS]
  if (!values?.length) return fallback.map(pct => pct / 100)
  const parsed = values.slice(0, 3).map(raw => {
    const num = Number(raw)
    if (!Number.isFinite(num) || num <= 0) return null
    return num > 1 ? num / 100 : num
  })
  if (parsed.some(value => value == null)) return fallback.map(pct => pct / 100)
  return parsed as number[]
}

export function parseLadderTrimPct(raw: string | undefined): number {
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) return LADDER_TRIM_FRACTION
  return num > 1 ? num / 100 : num
}

export function ladderGainPctsFromState(ladder?: PositionLadderState | null): string[] {
  if (ladder?.gain_fractions?.length) {
    return ladder.gain_fractions.slice(0, 3).map(value => String(Math.round(value * 100)))
  }
  return DEFAULT_LADDER_GAIN_PCTS.map(String)
}

export function ladderTrimPctFromState(ladder?: PositionLadderState | null): string {
  if (ladder?.trim_fraction != null && Number.isFinite(ladder.trim_fraction)) {
    const pct = ladder.trim_fraction <= 1 ? ladder.trim_fraction * 100 : ladder.trim_fraction
    return String(Math.round(pct))
  }
  return String(DEFAULT_LADDER_TRIM_PCT)
}

export function previewLadderLevels(
  entry: number,
  peak: number,
  gainPcts: string[],
  trimPct: string,
  isBuy: boolean,
  hits?: { l1_hit?: boolean; l2_hit?: boolean; l3_hit?: boolean },
  storedLevels?: PositionLadderLevel[],
): PositionLadderLevel[] {
  if (!(entry > 0) || !(peak > 0)) return []
  const peakGain = isBuy ? peak - entry : entry - peak
  if (peakGain <= 0) return []
  const fractions = extendedGainFractions(parseLadderGainPcts(gainPcts))
  const trim = parseLadderTrimPct(trimPct)
  const priorById = new Map<string, PositionLadderLevel>()
  for (const level of storedLevels ?? []) {
    if (level.id) priorById.set(level.id, level)
  }
  const hitMap = { L1: hits?.l1_hit, L2: hits?.l2_hit, L3: hits?.l3_hit }
  const levels: PositionLadderLevel[] = []
  for (let index = 0; index < fractions.length; index += 1) {
    const fraction = fractions[index]
    const id = `L${index + 1}`
    const prior = priorById.get(id)
    if (prior?.hit) {
      levels.push({ ...prior })
      continue
    }
    const price = isBuy ? entry + peakGain * fraction : entry - peakGain * fraction
    levels.push({
      id,
      gain_fraction: fraction,
      price: Math.round(price * 100) / 100,
      fraction: trim,
      label: `${Math.round(fraction * 100)}% of peak gain`,
      hit: Boolean(prior?.hit ?? hitMap[id as keyof typeof hitMap]),
    })
  }

  // Peak rose after every rung was hit — mirror backend extension toward peak.
  if (levels.length > 0 && levels.every(level => level.hit)) {
    const maxHitPrice = Math.max(...levels.map(level => level.price))
    if (peak > maxHitPrice + peakGain * 0.001) {
      const step = inferLadderStep(fractions)
      let lastFrac = Math.max(...levels.map(level => level.gain_fraction ?? 0))
      let nextIndex = levels.length + 1
      let maxPrice = maxHitPrice
      let frac = lastFrac + step
      while (frac <= LADDER_MAX_GAIN_FRACTION + 1e-9) {
        const eff = Math.min(frac, LADDER_MAX_GAIN_FRACTION)
        const price = isBuy ? entry + peakGain * eff : entry - peakGain * eff
        if (price > maxPrice + peakGain * 0.001) {
          levels.push({
            id: `L${nextIndex}`,
            gain_fraction: eff,
            price: Math.round(price * 100) / 100,
            fraction: trim,
            label: `${Math.round(eff * 100)}% of peak gain`,
            hit: false,
          })
          nextIndex += 1
          maxPrice = price
        }
        if (eff >= LADDER_MAX_GAIN_FRACTION - 1e-9) break
        frac += step
      }
      if (peak > maxPrice + peakGain * 0.001) {
        levels.push({
          id: `L${nextIndex}`,
          gain_fraction: LADDER_MAX_GAIN_FRACTION,
          price: Math.round(peak * 100) / 100,
          fraction: trim,
          label: '100% of peak gain',
          hit: false,
        })
      }
    }
  }

  return levels
}

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
  gain_fractions?: number[]
  trim_fraction?: number
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
    gain_fractions?: number[]
    trim_fraction?: number
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

export async function updatePositionLadderConfig(
  accountEnv: 'demo' | 'live',
  brokerPositionId: string,
  body: {
    gain_fractions?: number[]
    trim_fraction?: number
  },
): Promise<PositionLadderState> {
  const params = new URLSearchParams({ account_env: accountEnv })
  return parseJson(
    await fetch(
      `/api/control/position-ladder/${encodeURIComponent(brokerPositionId)}/config?${params}`,
      {
        method: 'PATCH',
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
