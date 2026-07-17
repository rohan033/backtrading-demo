export type BracketValueMode = 'price' | 'amount' | 'percent'

export type PositionBracketSettings = {
  takeProfitEnabled: boolean
  takeProfitValue: string
  takeProfitMode: BracketValueMode
  stopLossEnabled: boolean
  stopLossValue: string
  stopLossMode: BracketValueMode
}

const STORAGE_KEY = 'etoro-position-brackets:v1'

type BracketStore = Record<string, Record<string, PositionBracketSettings>>

export const DEFAULT_POSITION_BRACKETS: PositionBracketSettings = {
  takeProfitEnabled: false,
  takeProfitValue: '',
  takeProfitMode: 'price',
  stopLossEnabled: false,
  stopLossValue: '',
  stopLossMode: 'amount',
}

function readStore(): BracketStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as BracketStore
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeStore(store: BracketStore) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // ignore quota errors
  }
}

export function loadPositionBrackets(
  accountEnv: string,
  positionId: string,
): PositionBracketSettings {
  const env = accountEnv === 'live' ? 'live' : 'demo'
  const row = readStore()[env]?.[positionId]
  if (!row) return { ...DEFAULT_POSITION_BRACKETS }
  return {
    ...DEFAULT_POSITION_BRACKETS,
    ...row,
  }
}

function hasStoredBracketValues(settings: PositionBracketSettings): boolean {
  return Boolean(
    settings.takeProfitValue
    || settings.stopLossValue
    || settings.takeProfitEnabled
    || settings.stopLossEnabled,
  )
}

export function loadPositionBracketsForRow(
  accountEnv: string,
  storageKey: string,
  legacyKeys: string[] = [],
): PositionBracketSettings {
  const candidates = [storageKey, ...legacyKeys.filter(key => key && key !== storageKey)]
  for (const key of candidates) {
    const loaded = loadPositionBrackets(accountEnv, key)
    if (hasStoredBracketValues(loaded)) return loaded
  }
  return loadPositionBrackets(accountEnv, storageKey)
}

export function savePositionBrackets(
  accountEnv: string,
  positionId: string,
  patch: Partial<PositionBracketSettings>,
) {
  const env = accountEnv === 'live' ? 'live' : 'demo'
  const store = readStore()
  const current = loadPositionBrackets(accountEnv, positionId)
  const next = { ...current, ...patch }
  store[env] = { ...(store[env] || {}), [positionId]: next }
  writeStore(store)
  return next
}

export function bracketStorageKey(positionId: string, rowKey: string): string {
  const id = String(positionId || '').trim()
  if (id && !/^\d+$/.test(id)) return id
  if (id && id !== rowKey) return id
  return rowKey
}

export function loadAllPositionBrackets(
  accountEnv: string,
  positions: Array<{ positionId: string; rowKey: string }>,
): Record<string, PositionBracketSettings> {
  const out: Record<string, PositionBracketSettings> = {}
  for (const row of positions) {
    const key = bracketStorageKey(row.positionId, row.rowKey)
    out[key] = loadPositionBrackets(accountEnv, key)
  }
  return out
}

/** Convert a bracket target into an exit price for display. */
export function bracketTargetPrice(
  mode: BracketValueMode,
  rawValue: string,
  openRate: number,
  units: number,
  isBuy: boolean,
  kind: 'take_profit' | 'stop_loss',
): number | null {
  const value = Number(rawValue)
  if (!Number.isFinite(value) || !(openRate > 0) || !(units > 0)) return null
  const direction = isBuy ? 1 : -1
  if (mode === 'price') return value
  if (mode === 'percent') {
    const pct = value / 100
    if (kind === 'take_profit') {
      return isBuy ? openRate * (1 + pct) : openRate * (1 - pct)
    }
    return isBuy ? openRate * (1 - pct) : openRate * (1 + pct)
  }
  const delta = value / (units * direction)
  if (kind === 'take_profit') return openRate + delta
  return openRate - delta
}

/** P&L at the bracket target (positive = profit for TP, negative = loss for SL). */
export function bracketTargetPnl(
  mode: BracketValueMode,
  rawValue: string,
  openRate: number,
  units: number,
  isBuy: boolean,
  kind: 'take_profit' | 'stop_loss',
): number | null {
  const price = bracketTargetPrice(mode, rawValue, openRate, units, isBuy, kind)
  if (price == null) return null
  if (mode === 'amount') {
    const amount = Number(rawValue)
    if (!Number.isFinite(amount)) return null
    return kind === 'take_profit' ? amount : -Math.abs(amount)
  }
  if (mode === 'percent') {
    const pct = Number(rawValue)
    if (!Number.isFinite(pct)) return null
    const dollars = openRate * (pct / 100) * units
    return kind === 'take_profit' ? dollars : -Math.abs(dollars)
  }
  const direction = isBuy ? 1 : -1
  return (price - openRate) * units * direction
}

function bracketModeLabel(mode: BracketValueMode): string {
  if (mode === 'percent') return '%'
  if (mode === 'amount') return '$'
  return 'price'
}

function formatBracketSide(
  label: 'TP' | 'SL',
  enabled: boolean,
  mode: BracketValueMode,
  value: string,
): string {
  const trimmed = value.trim()
  if (!enabled && !trimmed) return `${label} off`
  const state = enabled ? 'on' : 'off'
  if (!trimmed) return `${label} ${state}`
  return `${label} ${trimmed} ${bracketModeLabel(mode)} (${state})`
}

export function formatPositionBracketSummary(settings: PositionBracketSettings): {
  takeProfit: string
  stopLoss: string
} {
  return {
    takeProfit: formatBracketSide(
      'TP',
      settings.takeProfitEnabled,
      settings.takeProfitMode,
      settings.takeProfitValue,
    ),
    stopLoss: formatBracketSide(
      'SL',
      settings.stopLossEnabled,
      settings.stopLossMode,
      settings.stopLossValue,
    ),
  }
}
