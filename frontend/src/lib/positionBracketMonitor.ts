import {
  bracketTargetPnl,
  bracketTargetPrice,
  loadPositionBracketsForRow,
  savePositionBrackets,
  type BracketValueMode,
  type PositionBracketSettings,
} from './positionBrackets'
import { positionLivePnl, isVerifiedBrokerPositionId, type EtoroPositionRow } from './etoroPositions'

export type BracketTriggerKind = 'take_profit' | 'stop_loss'

export type MonitoredPosition = {
  row: EtoroPositionRow
  storageKey: string
  ticker: string
}

export function isBrokerClosablePosition(row: EtoroPositionRow): boolean {
  return isVerifiedBrokerPositionId(row)
}

/** True when live price has reached/crossed a price-mode bracket target. */
export function bracketPriceCrossed(
  isBuy: boolean,
  livePrice: number,
  targetPrice: number,
  kind: 'take_profit' | 'stop_loss',
): boolean {
  if (kind === 'take_profit') {
    return isBuy ? livePrice >= targetPrice : livePrice <= targetPrice
  }
  return isBuy ? livePrice <= targetPrice : livePrice >= targetPrice
}

function assignedTakeProfit(row: EtoroPositionRow, brackets: PositionBracketSettings): number | null {
  if (!brackets.takeProfitValue.trim()) return null
  if (brackets.takeProfitMode === 'amount') {
    const dollars = Number(brackets.takeProfitValue)
    return Number.isFinite(dollars) && dollars > 0 ? dollars : null
  }
  const mode = brackets.takeProfitMode === 'percent' ? 'percent' : 'price'
  const pnl = bracketTargetPnl(
    mode,
    brackets.takeProfitValue,
    row.openRate,
    row.quantity,
    row.isBuy,
    'take_profit',
  )
  return pnl != null && pnl > 0 ? pnl : null
}

function assignedStopLoss(row: EtoroPositionRow, brackets: PositionBracketSettings): number | null {
  if (!brackets.stopLossValue.trim()) return null
  if (brackets.stopLossMode === 'amount') {
    const dollars = Math.abs(Number(brackets.stopLossValue))
    return Number.isFinite(dollars) && dollars > 0 ? dollars : null
  }
  const mode = brackets.stopLossMode === 'percent' ? 'percent' : 'price'
  const pnl = bracketTargetPnl(
    mode,
    brackets.stopLossValue,
    row.openRate,
    row.quantity,
    row.isBuy,
    'stop_loss',
  )
  return pnl != null ? Math.abs(pnl) : null
}

function priceModeTargetCrossed(
  row: EtoroPositionRow,
  livePrice: number,
  mode: BracketValueMode,
  rawValue: string,
  kind: 'take_profit' | 'stop_loss',
): boolean {
  if (mode !== 'price') return true
  const targetPrice = bracketTargetPrice(
    'price',
    rawValue,
    row.openRate,
    row.quantity,
    row.isBuy,
    kind,
  )
  if (targetPrice == null || !(livePrice > 0)) return false
  return bracketPriceCrossed(row.isBuy, livePrice, targetPrice, kind)
}

function shouldTriggerStopLoss(
  row: EtoroPositionRow,
  brackets: PositionBracketSettings,
  pnl: number,
  livePrice: number,
): boolean {
  if (pnl >= 0 || !brackets.stopLossEnabled) return false

  const maxLoss = assignedStopLoss(row, brackets)
  if (maxLoss == null || Math.abs(pnl) < maxLoss) return false

  // Amount/% modes: P&L threshold only — never gate on implied price vs liveMark,
  // or a surpassed $/%% stop can never fire once price gaps past it.
  return priceModeTargetCrossed(row, livePrice, brackets.stopLossMode, brackets.stopLossValue, 'stop_loss')
}

function shouldTriggerTakeProfit(
  row: EtoroPositionRow,
  brackets: PositionBracketSettings,
  pnl: number,
  livePrice: number,
): boolean {
  if (pnl <= 0 || !brackets.takeProfitEnabled) return false

  const targetProfit = assignedTakeProfit(row, brackets)
  if (targetProfit == null || pnl < targetProfit) return false

  // Amount/% modes: P&L threshold only — never gate on implied price vs liveMark,
  // or a surpassed $/%% target can never fire once price runs past it.
  return priceModeTargetCrossed(row, livePrice, brackets.takeProfitMode, brackets.takeProfitValue, 'take_profit')
}

/** Each tick: loss → SL, profit → TP. Returns why to close, or null. */
export function checkBracketOnTick(
  row: EtoroPositionRow,
  brackets: PositionBracketSettings,
  livePrice: number,
): BracketTriggerKind | null {
  const live = positionLivePnl(row, livePrice)
  if (!live || !(livePrice > 0)) return null

  const { pnl } = live

  if (shouldTriggerStopLoss(row, brackets, pnl, livePrice)) return 'stop_loss'
  if (shouldTriggerTakeProfit(row, brackets, pnl, livePrice)) return 'take_profit'

  return null
}

/** @deprecated alias */
export const evaluateBracketTrigger = checkBracketOnTick

export function loadBracketsForMonitoredRow(
  accountEnv: string,
  monitored: MonitoredPosition,
): PositionBracketSettings {
  return loadPositionBracketsForRow(accountEnv, monitored.storageKey, [
    monitored.row.brokerPositionId,
    monitored.row.positionId,
    monitored.row.symboltoken,
  ])
}

export function hasActiveBracket(brackets: PositionBracketSettings): boolean {
  return (
    (brackets.takeProfitEnabled && brackets.takeProfitValue.trim().length > 0)
    || (brackets.stopLossEnabled && brackets.stopLossValue.trim().length > 0)
  )
}

export function disableBracketsAfterClose(
  accountEnv: string,
  storageKey: string,
): void {
  savePositionBrackets(accountEnv, storageKey, {
    takeProfitEnabled: false,
    stopLossEnabled: false,
  })
}

const closingKeys = new Set<string>()

export function isBracketCloseInFlight(rowKey: string): boolean {
  return closingKeys.has(rowKey)
}

export function markBracketCloseInFlight(rowKey: string) {
  closingKeys.add(rowKey)
}

export function clearBracketCloseInFlight(rowKey: string) {
  closingKeys.delete(rowKey)
}

export function countEnabledBrackets(
  accountEnv: string,
  rows: MonitoredPosition[],
  autoLadderIds: ReadonlySet<string> = new Set(),
): number {
  let count = 0
  for (const monitored of rows) {
    const pid = monitored.row.brokerPositionId
    if (pid && autoLadderIds.has(pid)) count += 1
    const brackets = loadBracketsForMonitoredRow(accountEnv, monitored)
    if (brackets.takeProfitEnabled && brackets.takeProfitValue.trim()) count += 1
    if (brackets.stopLossEnabled && brackets.stopLossValue.trim()) count += 1
  }
  return count
}
