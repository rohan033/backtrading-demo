import { useEffect, useMemo, useState } from 'react'

import {
  formatMonitoredTradePnl,
  useMomentumTradesMonitor,
  type MonitoredMomentumTrade,
  type MomentumTradeOpenPosition,
} from '../../hooks/useMomentumTradesMonitor'
import { formatBrokerMoney } from '../../lib/currency'
import { closeExecutionPosition, type ExecutionPositionRow } from '../../lib/executionPositions'
import { showPlatformToast } from '../../lib/platform-toast'
import {
  clearMomentumTrades,
  loadMomentumTrades,
  removeMomentumTrade,
  WL_MOMENTUM_TRADE_EVENT,
} from '../../lib/watchlistMomentumState'
import { watchlistTickKey } from '../../lib/watchlists'
import type { WatchlistTick } from '../../lib/watchlists'

function statusLabel(status: MonitoredMomentumTrade['status']): string {
  switch (status) {
    case 'open':
      return 'Open'
    case 'closed':
      return 'Completed'
    case 'pending':
      return 'Pending'
    default:
      return 'Error'
  }
}

function statusClass(status: MonitoredMomentumTrade['status']): string {
  switch (status) {
    case 'open':
      return 'ms-mom-order__status--open'
    case 'closed':
      return 'ms-mom-order__status--closed'
    case 'pending':
      return 'ms-mom-order__status--pending'
    default:
      return 'ms-mom-order__status--error'
  }
}

function PositionCloseRow({
  position,
  closing,
  onClose,
}: {
  position: MomentumTradeOpenPosition
  closing: boolean
  onClose: () => void
}) {
  return (
    <div className="ms-mom-order__broker-section ms-mom-order__broker-section--position">
      <div className="ms-mom-order__broker-section-head">
        <span className="ms-mom-order__broker-section-label">Position</span>
        <button
          type="button"
          className="ms-mom-order__close-pos"
          disabled={!position.closable || closing}
          title={position.closable ? `Close position ${position.positionId}` : 'Position not closable yet'}
          onClick={onClose}
        >
          {closing ? 'Closing…' : 'Close'}
        </button>
      </div>
      <div className="ms-mom-order__broker-section-body">
        <span className="ms-mom-order__mono">{position.positionId}</span>
        {position.units != null ? (
          <span className="ms-mom-order__broker-detail">{position.units} units</span>
        ) : null}
        {!position.onBroker ? (
          <span className="ms-mom-order__broker-detail ms-mom-order__broker-detail--warn">not on broker</span>
        ) : null}
      </div>
    </div>
  )
}

function orderStatusLabel(status: MonitoredMomentumTrade['orderStatus'], kind: string | null): string {
  switch (status) {
    case 'pending':
      if (kind === 'Open') return 'Pending Open'
      return kind ? `Pending (${kind})` : 'Pending on eToro'
    case 'filled':
      return 'Filled'
    case 'cancelled':
      return 'Cancelled'
    default:
      return 'Unknown'
  }
}

function MomentumOrderRow({
  trade,
  currentPrice,
  onRemove,
  onRefresh,
}: {
  trade: MonitoredMomentumTrade
  currentPrice: number | null
  onRemove: (id: string) => void
  onRefresh: () => void
}) {
  const [closingId, setClosingId] = useState<string | null>(null)
  const pnlLabel = formatMonitoredTradePnl(trade)
  const bracket = trade.noTakeProfit ? 'no TP · 1% SL' : `${trade.accountEnv === 'live' ? 'LIVE' : 'DEMO'} bracket`
  const pnlUp = trade.status === 'open'
    ? (trade.livePnl?.pnl ?? 0) >= 0
    : (trade.realizedPnl ?? 0) >= 0
  const displayLtp = trade.brokerLtp ?? currentPrice

  const handleClosePosition = async (position: MomentumTradeOpenPosition) => {
    if (!trade.executionId || !position.closable) return
    setClosingId(position.positionId)
    try {
      const sellPrice = trade.brokerLtp ?? currentPrice ?? trade.entryPrice
      const livePnl = trade.status === 'open' ? trade.livePnl : null
      await closeExecutionPosition(
        trade.executionId,
        {
          position_id: position.positionId,
          instrument_id: position.instrumentId,
          remaining_units: position.units,
          closable: true,
          source: 'control',
        } as ExecutionPositionRow,
        position.units,
        {
          source: 'momentum',
          ticker: trade.tradingsymbol,
          buy_price: trade.entryPrice,
          sell_price: sellPrice,
          pnl: livePnl?.pnl ?? trade.realizedPnl,
          pnl_pct: livePnl?.pnlPct ?? trade.realizedPnlPct,
          close_reason: 'manual',
          take_profit_config: trade.noTakeProfit ? 'TP off' : 'TP default bracket',
          stop_loss_config: 'SL 1%',
        },
      )
      showPlatformToast({
        variant: 'success',
        title: 'Position closed',
        message: `${trade.tradingsymbol} · ${position.positionId}`,
        duration: 5000,
      })
      onRefresh()
    } catch (error) {
      showPlatformToast({
        variant: 'error',
        title: 'Close failed',
        message: error instanceof Error ? error.message : 'Could not close position',
        duration: 8000,
      })
    } finally {
      setClosingId(null)
    }
  }

  return (
    <div className="ms-mom-order">
      <div className="ms-mom-order__top">
        <span className={`ms-mom-order__env ms-mom-order__env--${trade.accountEnv}`}>
          {trade.accountEnv}
        </span>
        <span className={`ms-mom-order__status ${statusClass(trade.status)}`}>
          {statusLabel(trade.status)}
        </span>
        {trade.dataSource ? (
          <span className="ms-mom-order__source">{trade.dataSource}</span>
        ) : null}
        <button
          type="button"
          className="ms-mom-order__remove"
          title="Remove from list"
          onClick={() => onRemove(trade.id)}
        >
          ×
        </button>
      </div>
      <div className="ms-mom-order__symbol">{trade.tradingsymbol}</div>
      <div className="ms-mom-order__meta">
        Entry {formatBrokerMoney(trade.broker, trade.entryPrice)}
        {displayLtp != null ? (
          <> · LTP {formatBrokerMoney(trade.broker, displayLtp)}</>
        ) : null}
        {trade.units != null ? <> · {trade.units} units</> : null}
        {' · '}{bracket}
      </div>
      {(trade.orderId != null || trade.openPositions.length > 0) ? (
        <div className="ms-mom-order__broker-block">
          {trade.orderId != null ? (
            <div className="ms-mom-order__broker-section">
              <div className="ms-mom-order__broker-section-label">Order</div>
              <div className="ms-mom-order__broker-section-body">
                <span className="ms-mom-order__mono">{trade.orderId}</span>
                <span className={`ms-mom-order__order-state ms-mom-order__order-state--${trade.orderStatus}`}>
                  {orderStatusLabel(trade.orderStatus, trade.orderKind)}
                </span>
              </div>
            </div>
          ) : null}
          {trade.openPositions.map(position => (
            <PositionCloseRow
              key={position.positionId}
              position={position}
              closing={closingId === position.positionId}
              onClose={() => void handleClosePosition(position)}
            />
          ))}
        </div>
      ) : null}
      {pnlLabel ? (
        <div className={`ms-mom-order__pnl${pnlUp ? ' ms-mom-order__pnl--up' : ' ms-mom-order__pnl--down'}`}>
          {pnlLabel}
        </div>
      ) : trade.status === 'pending' ? (
        <div className="ms-mom-order__pnl ms-mom-order__pnl--muted">
          {trade.pendingOrderCount > 0 ? 'Order pending on eToro…' : 'Waiting for fill…'}
        </div>
      ) : null}
      <div className="ms-mom-order__time">
        {new Date(trade.createdAt).toLocaleString([], {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        })}
        {trade.lastCheckedAt ? (
          <span className="ms-mom-order__refresh">
            {' · '}refreshed {new Date(trade.lastCheckedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        ) : null}
      </div>
    </div>
  )
}

export default function MomentumOrdersPanel({
  ticks,
  filterText,
  executionIds,
  sessionScoped = false,
  compact = false,
  title = 'Momentum orders',
  emptyMessage,
}: {
  ticks: Record<string, WatchlistTick>
  filterText?: string
  executionIds?: string[]
  /** When true, never show global momentum trades — session-only (empty until deploy). */
  sessionScoped?: boolean
  compact?: boolean
  title?: string
  emptyMessage?: string
}) {
  const {
    trades: monitored,
    refresh,
    isRefreshing,
    lastRefreshedAt,
  } = useMomentumTradesMonitor(ticks)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    window.addEventListener(WL_MOMENTUM_TRADE_EVENT, bump)
    return () => window.removeEventListener(WL_MOMENTUM_TRADE_EVENT, bump)
  }, [])

  const trades = useMemo(() => {
    void version
    const query = (filterText ?? '').trim().toLowerCase()
    const scoped = sessionScoped || executionIds !== undefined
    const idSet = scoped
      ? new Set((executionIds ?? []).map(id => id.trim()).filter(Boolean))
      : null
    return monitored.filter(trade => {
      if (idSet !== null && !idSet.has(trade.executionId)) return false
      if (!query) return true
      return (
        trade.tradingsymbol.toLowerCase().includes(query)
        || trade.executionId.toLowerCase().includes(query)
        || String(trade.positionId ?? '').toLowerCase().includes(query)
        || String(trade.orderId ?? '').toLowerCase().includes(query)
        || trade.openPositions.some(pos => pos.positionId.includes(query))
      )
    })
  }, [monitored, filterText, version, executionIds, sessionScoped])

  const handleRemove = (id: string) => {
    removeMomentumTrade(id)
    window.dispatchEvent(new CustomEvent(WL_MOMENTUM_TRADE_EVENT))
    setVersion(v => v + 1)
  }

  const handleClear = () => {
    clearMomentumTrades()
    window.dispatchEvent(new CustomEvent(WL_MOMENTUM_TRADE_EVENT))
    setVersion(v => v + 1)
  }

  if (!trades.length) {
    if (sessionScoped || executionIds !== undefined) {
      return (
        <div className={`ms-mom-orders${compact ? ' ms-mom-orders--compact' : ''}`}>
          {compact ? (
            <div className="ms-mom-orders__header ms-mom-orders__header--compact">
              <strong>{title}</strong>
            </div>
          ) : null}
          <div className="ms-news-empty">
            {emptyMessage ?? 'No orders for this session yet.'}
          </div>
        </div>
      )
    }
    if (!loadMomentumTrades().length) {
      return (
        <div className="ms-news-empty">
          {emptyMessage ?? 'No momentum orders yet. Arm symbols with ⚡ in Watch & Trade — auto-deployed orders appear here with live P&L.'}
        </div>
      )
    }
    return null
  }

  const openCount = trades.filter(t => t.status === 'open').length
  const completedCount = trades.filter(t => t.status === 'closed').length

  return (
    <div className={`ms-mom-orders${compact ? ' ms-mom-orders--compact' : ''}`}>
      {!compact ? (
        <div className="ms-mom-orders__header">
          <div>
            <strong>{title}</strong>
            <span>
              {trades.length} total
              {openCount ? ` · ${openCount} open` : ''}
              {completedCount ? ` · ${completedCount} completed` : ''}
              {' · '}poll 15s per execution
              {lastRefreshedAt ? (
                <> · last {new Date(lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>
              ) : null}
            </span>
          </div>
          <div className="ms-mom-orders__actions">
            <button
              type="button"
              className="ms-mom-orders__refresh"
              onClick={() => void refresh()}
              disabled={isRefreshing}
              title="Refresh broker data for momentum executions"
            >
              {isRefreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <button type="button" className="ms-mom-orders__clear" onClick={handleClear}>
              Clear
            </button>
          </div>
        </div>
      ) : (
        <div className="ms-mom-orders__header ms-mom-orders__header--compact">
          <strong>{title}</strong>
          <button
            type="button"
            className="ms-mom-orders__refresh"
            onClick={() => void refresh()}
            disabled={isRefreshing}
            title="Refresh order status"
          >
            {isRefreshing ? '…' : '↻'}
          </button>
        </div>
      )}
      <div className="ms-mom-orders__list">
        {trades.map(trade => {
          const tickKey = watchlistTickKey(trade.broker, trade.accountEnv, trade.symboltoken)
          const currentPrice = ticks[tickKey]?.ltp ?? null
          return (
            <MomentumOrderRow
              key={trade.id}
              trade={trade}
              currentPrice={currentPrice}
              onRemove={handleRemove}
              onRefresh={() => void refresh()}
            />
          )
        })}
      </div>
    </div>
  )
}
