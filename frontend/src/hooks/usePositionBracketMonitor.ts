import { useEffect, useRef, useState } from 'react'

import {
  CloseEtoroPositionError,
  closeEtoroPosition,
  formatCloseEtoroDebug,
  logCloseEtoroExchange,
  watchCloseSettlement,
} from '@/lib/closeEtoroPosition'
import type { ClosedPositionRef } from '@/lib/etoroPositions'
import {
  checkBracketOnTick,
  clearBracketCloseInFlight,
  disableBracketsAfterClose,
  isBracketCloseInFlight,
  isBrokerClosablePosition,
  loadBracketsForMonitoredRow,
  markBracketCloseInFlight,
  type MonitoredPosition,
} from '@/lib/positionBracketMonitor'
import { positionLivePnl } from '@/lib/etoroPositions'
import {
  formatPositionBracketSummary,
} from '@/lib/positionBrackets'
import { showPlatformToast } from '@/lib/platform-toast'

type Params = {
  accountEnv: 'demo' | 'live'
  rows: MonitoredPosition[]
  prices: Readonly<Record<string, number>>
  autoLadderPositionIds?: ReadonlySet<string>
  enabled?: boolean
  onClosed?: (closed: ClosedPositionRef) => void
}

export function usePositionBracketMonitor({
  accountEnv,
  rows,
  prices,
  autoLadderPositionIds = new Set(),
  enabled = true,
  onClosed,
}: Params) {
  const [closingKeys, setClosingKeys] = useState<Set<string>>(() => new Set())
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  useEffect(() => {
    if (!enabled || !rows.length) return

    for (const monitored of rows) {
      const { row, storageKey, ticker } = monitored
      const rowKey = row.rowKey
      const positionId = row.brokerPositionId

      if (positionId && autoLadderPositionIds.has(positionId)) continue

      if (isBracketCloseInFlight(rowKey)) continue

      const livePrice = prices[rowKey]
      if (!(livePrice > 0)) continue

      const brackets = loadBracketsForMonitoredRow(accountEnv, monitored)
      const trigger = checkBracketOnTick(row, brackets, livePrice)
      if (!trigger) continue

      if (!isBrokerClosablePosition(row) || !positionId) {
        showPlatformToast({
          variant: 'error',
          title: 'Cannot close',
          message: `${ticker}: missing broker position id. Refresh first.`,
          duration: 8000,
        })
        continue
      }

      markBracketCloseInFlight(rowKey)
      setClosingKeys(prev => new Set(prev).add(rowKey))

      const label = trigger === 'take_profit' ? 'Take profit' : 'Stop loss'
      const bracketSummary = formatPositionBracketSummary(brackets)
      const live = positionLivePnl(row, livePrice)
      void closeEtoroPosition(positionId, accountEnv, {
        instrumentId: row.symboltoken,
        notify: {
          source: 'bracket',
          ticker,
          buy_price: row.openRate,
          sell_price: livePrice,
          pnl: live?.pnl ?? row.brokerPnl,
          pnl_pct: live?.pnlPct,
          close_reason: trigger === 'take_profit' ? 'take_profit' : 'stop_loss',
          take_profit_config: bracketSummary.takeProfit,
          stop_loss_config: bracketSummary.stopLoss,
        },
      })
        .then(result => {
          logCloseEtoroExchange(ticker, result)
          watchCloseSettlement(result, ticker)
          disableBracketsAfterClose(accountEnv, storageKey)
          showPlatformToast({
            variant: 'success',
            title: `${label} hit — closed`,
            message: `${ticker} · position ${positionId}`,
            duration: 8000,
          })
          onClosedRef.current?.({ rowKey, brokerPositionId: positionId })
        })
        .catch(error => {
          clearBracketCloseInFlight(rowKey)
          const closeError = error instanceof CloseEtoroPositionError ? error : null
          logCloseEtoroExchange(ticker, null, closeError)
          const debugText = formatCloseEtoroDebug(closeError?.debug)
          const message = error instanceof Error ? error.message : 'Could not close position'
          showPlatformToast({
            variant: 'error',
            title: `${label} close failed`,
            message: debugText ? `${message}\n\n${debugText}` : message,
            duration: 20000,
          })
        })
        .finally(() => {
          setClosingKeys(prev => {
            const next = new Set(prev)
            next.delete(rowKey)
            return next
          })
        })
    }
  }, [accountEnv, autoLadderPositionIds, enabled, prices, rows])

  return { closingKeys }
}
