import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import SymbolLogo from '@/components/SymbolLogo'
import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'
import {
  closeEtoroPosition,
  logCloseEtoroExchange,
  watchCloseSettlement,
} from '@/lib/closeEtoroPosition'
import {
  closeOnePercentPosition,
  getOnePercentSession,
  isTerminalOnePercentState,
  onePercentSessionLabel,
  pollOnePercentSessionEvents,
  stopOnePercentSession,
  type OnePercentSession,
  type OnePercentSessionDetail,
  type OnePercentSessionEvent,
} from '@/lib/onePercentSessions'

type Props = {
  sessionId: string
  onSessionUpdate?: (session: OnePercentSession) => void
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // ignore
    }
  }
  return {}
}

function money(value: unknown, digits = 2): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(num)
}

function pct(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '—'
  const prefix = num > 0 ? '+' : ''
  return `${prefix}${num.toFixed(2)}%`
}

function pnlClass(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num === 0) return ''
  return num > 0 ? 'opc-pos' : 'opc-neg'
}

function reasoningBulletsFromPayload(payload: Record<string, unknown>): string[] {
  const raw = payload.reasoning_bullets
  if (!Array.isArray(raw)) return []
  return raw.map(item => String(item || '').trim()).filter(Boolean).slice(0, 4)
}

type PickStatusRowData = {
  key: string
  name: string
  ok: boolean
  reason: string
  bullets: string[]
  confidence: number | null
  sources: Array<Record<string, unknown>>
}

function buildPickStatusRows(events: OnePercentSessionEvent[]): PickStatusRowData[] {
  const rows: PickStatusRowData[] = []
  const seen = new Set<string>()

  const push = (row: PickStatusRowData) => {
    if (seen.has(row.key)) return
    seen.add(row.key)
    rows.push(row)
  }

  for (const event of events) {
    const payload = asRecord(event.payload)
    const bullets = reasoningBulletsFromPayload(payload)
    const confidence = payload.confidence != null && Number.isFinite(Number(payload.confidence))
      ? Number(payload.confidence)
      : null
    const sources = Array.isArray(payload.sources)
      ? payload.sources.filter(item => item && typeof item === 'object') as Array<Record<string, unknown>>
      : []

    if (event.event_type === 'candidates_found') {
      const unresolved = Array.isArray(payload.unresolved) ? payload.unresolved : []
      for (const item of unresolved) {
        const row = asRecord(item)
        const symbol = String(row.symbol || '').trim()
        if (!symbol) continue
        push({
          key: `unresolved:${symbol}`,
          name: symbol,
          ok: false,
          reason: String(row.reason || 'Not tradeable on eToro'),
          bullets: [],
          confidence: null,
          sources: [],
        })
      }
      continue
    }

    if (event.event_type === 'stock_selected') {
      const symbol = String(payload.symbol || '').trim()
      const name = String(payload.name || symbol || '—').trim()
      const label = symbol && name && name !== symbol ? `${symbol} · ${name}` : (symbol || name)
      push({
        key: `selected:${event.id}`,
        name: label,
        ok: true,
        reason: '',
        bullets,
        confidence,
        sources,
      })
      continue
    }

    if (event.event_type === 'agent_no_place') {
      const symbol = String(payload.symbol || '').trim() || 'Selection'
      push({
        key: `noplace:${event.id}`,
        name: symbol,
        ok: false,
        reason: bullets[0]
          || (confidence != null ? `AI declined (conf ${confidence.toFixed(0)})` : 'AI declined to place'),
        bullets,
        confidence,
        sources,
      })
      continue
    }

    if (
      event.event_type === 'order_failed'
      || event.event_type === 'screening_failed'
      || event.event_type === 'agent_selection_failed'
    ) {
      const symbol = String(payload.symbol || '').trim() || 'Session'
      push({
        key: `fail:${event.id}`,
        name: symbol,
        ok: false,
        reason: String(payload.error || payload.reason || 'Failed'),
        bullets: [],
        confidence: null,
        sources: [],
      })
      continue
    }

    if (event.event_type === 'session_finished') {
      const outcome = String(payload.outcome || '')
      const reason = String(payload.reason || '').trim()
      if (
        outcome === 'no_candidates'
        || outcome === 'agent_no_place'
        || outcome === 'screening_failed'
        || outcome === 'sizing_failed'
        || outcome === 'order_failed'
      ) {
        const symbol = String(payload.symbol || payload.active_symbol || 'Session').trim()
        push({
          key: `finished:${event.id}`,
          name: symbol,
          ok: false,
          reason: reason || outcome.replace(/_/g, ' '),
          bullets: [],
          confidence: null,
          sources: [],
        })
      }
    }
  }

  return rows
}

function ReasoningAccordion({
  bullets,
  confidence,
  sources,
  defaultOpen = true,
}: {
  bullets: string[]
  confidence?: number | null
  sources?: Array<Record<string, unknown>>
  defaultOpen?: boolean
}) {
  if (!bullets.length) return null
  const sourceLabels = (sources || [])
    .map(item => String(item.label || '').trim())
    .filter(Boolean)
  return (
    <details className="opc-reason" open={defaultOpen}>
      <summary className="opc-reason__summary">
        Why selected
        {confidence != null && Number.isFinite(confidence) ? (
          <em>conf {confidence.toFixed(0)}</em>
        ) : null}
      </summary>
      <ul className="opc-reason__list">
        {bullets.map((bullet, index) => (
          <li key={`${index}-${bullet.slice(0, 24)}`}>{bullet}</li>
        ))}
      </ul>
      {sourceLabels.length ? (
        <div className="opc-reason__sources">
          Sources: {sourceLabels.join(' · ')}
        </div>
      ) : null}
    </details>
  )
}

function PickStatusRow({ row }: { row: PickStatusRowData }) {
  return (
    <div className={`opc-pick ${row.ok ? 'opc-pick--ok' : 'opc-pick--bad'}`.trim()}>
      <div className="opc-pick__main">
        <span className={`opc-pick__icon ${row.ok ? 'opc-pick__icon--ok' : 'opc-pick__icon--bad'}`} aria-hidden>
          {row.ok ? '✓' : '✕'}
        </span>
        <div className="opc-pick__body">
          <strong className="opc-pick__name">{row.name}</strong>
          {!row.ok && row.reason ? (
            <span className="opc-pick__reason">{row.reason}</span>
          ) : null}
        </div>
      </div>
      {row.bullets.length ? (
        <ReasoningAccordion
          bullets={row.bullets}
          confidence={row.confidence}
          sources={row.sources}
          defaultOpen={row.ok}
        />
      ) : null}
    </div>
  )
}

type OrderMonitorRowData = {
  symbol: string
  orderId: string | null
  positionId: string | null
  status: string
  lastCheckAt: string | null
  filled: boolean
  estimatedPnl: number | null
  estimatedPnlPct: number | null
  remainingToTarget: number | null
  goalPctComplete: number | null
  remainingToTp: number | null
  tpPctComplete: number | null
  takeProfitPct: number | null
  remainingToSl: number | null
  slPctComplete: number | null
  stopLossPct: number | null
  canClose: boolean
  positionClosed: boolean
  entryPrice: number | null
  tpPrice: number | null
  slPrice: number | null
  currentPrice: number | null
}

function clampPct(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100
}

function computeTpProgress({
  pnlPct,
  takeProfitPct,
  entry,
  tpPrice,
  current,
  quantity,
  pnl,
}: {
  pnlPct: number | null
  takeProfitPct: number | null
  entry: number | null
  tpPrice: number | null
  current: number | null
  quantity: number | null
  pnl: number | null
}): { tpPctComplete: number | null; remainingToTp: number | null } {
  if (takeProfitPct != null && takeProfitPct > 0 && pnlPct != null) {
    const remainingToTp = entry != null && quantity != null && quantity > 0 && pnl != null
      ? Math.round((entry * (takeProfitPct / 100) * quantity - pnl) * 100) / 100
      : null
    return { tpPctComplete: clampPct((pnlPct / takeProfitPct) * 100), remainingToTp }
  }
  if (
    entry != null && entry > 0
    && tpPrice != null && tpPrice > 0
    && current != null
    && tpPrice !== entry
  ) {
    const span = tpPrice - entry
    const remainingToTp = quantity != null && quantity > 0
      ? Math.round((tpPrice - current) * quantity * 100) / 100
      : null
    return {
      tpPctComplete: clampPct(((current - entry) / span) * 100),
      remainingToTp,
    }
  }
  return { tpPctComplete: null, remainingToTp: null }
}

function computeSlProgress({
  pnlPct,
  stopLossPct,
  entry,
  slPrice,
  current,
  quantity,
  pnl,
}: {
  pnlPct: number | null
  stopLossPct: number | null
  entry: number | null
  slPrice: number | null
  current: number | null
  quantity: number | null
  pnl: number | null
}): { slPctComplete: number | null; remainingToSl: number | null } {
  if (stopLossPct != null && stopLossPct > 0 && pnlPct != null) {
    // 0% at entry/green; 100% when live loss reaches configured SL %.
    const remainingToSl = entry != null && quantity != null && quantity > 0 && pnl != null
      ? Math.round((entry * (stopLossPct / 100) * quantity + pnl) * 100) / 100
      : null
    return {
      slPctComplete: clampPct((-pnlPct / stopLossPct) * 100),
      remainingToSl,
    }
  }
  if (
    entry != null && entry > 0
    && slPrice != null && slPrice > 0
    && current != null
    && slPrice !== entry
  ) {
    const span = entry - slPrice
    if (span <= 0) return { slPctComplete: null, remainingToSl: null }
    const remainingToSl = quantity != null && quantity > 0
      ? Math.round((current - slPrice) * quantity * 100) / 100
      : null
    return {
      slPctComplete: clampPct(((entry - current) / span) * 100),
      remainingToSl,
    }
  }
  return { slPctComplete: null, remainingToSl: null }
}

function eventsForActiveAttempt(
  events: OnePercentSessionEvent[],
  session: OnePercentSession | null,
): OnePercentSessionEvent[] {
  const activeAttemptId = session?.active_attempt_id ? String(session.active_attempt_id) : ''
  if (!activeAttemptId) return events
  return events.filter(event => {
    const payload = asRecord(event.payload)
    const attemptId = payload.attempt_id
    if (attemptId == null || attemptId === '') {
      // Ignore prior-attempt close/complete events that lack an attempt id.
      return !(
        event.event_type === 'attempt_completed'
        || event.event_type === 'force_close_started'
        || event.event_type === 'manual_close_requested'
      )
    }
    return String(attemptId) === activeAttemptId
  })
}

function buildOrderMonitorRow(
  events: OnePercentSessionEvent[],
  session: OnePercentSession | null,
  livePnl?: { pnl: number | null; pnlPct: number | null; currentPrice?: number | null },
): OrderMonitorRowData | null {
  const scopedEvents = eventsForActiveAttempt(events, session)
  let orderId: string | null = session?.active_order_id ? String(session.active_order_id) : null
  let positionId: string | null = session?.active_position_id ? String(session.active_position_id) : null
  let symbol = String(session?.active_symbol || '')
  let lastCheckAt: string | null = null
  let filled = false
  let seenOrder = false
  let positionClosed = false
  let estimatedPnl: number | null = null
  let estimatedPnlPct: number | null = null
  let remainingToTarget: number | null = null
  let goalPctComplete: number | null = null
  let remainingToTp: number | null = null
  let tpPctComplete: number | null = null
  let takeProfitPct: number | null = null
  let remainingToSl: number | null = null
  let slPctComplete: number | null = null
  let stopLossPct: number | null = null
  let entryPrice: number | null = null
  let tpPrice: number | null = null
  let slPrice: number | null = null
  let currentPrice: number | null = null
  let quantity: number | null = null

  for (const event of scopedEvents) {
    const payload = asRecord(event.payload)
    if (event.event_type === 'order_placed') {
      seenOrder = true
      positionClosed = false
      orderId = String(payload.order_id || orderId || '') || null
      symbol = String(payload.symbol || symbol || '')
      if (!lastCheckAt) lastCheckAt = event.created_at
    }
    if (event.event_type === 'entry_filled' || event.event_type === 'order_configured') {
      seenOrder = true
      positionClosed = false
      if (event.event_type === 'entry_filled') {
        filled = true
      }
      orderId = String(payload.order_id || orderId || '') || null
      positionId = String(payload.position_id || positionId || '') || null
      symbol = String(payload.symbol || symbol || '')
      lastCheckAt = event.created_at
      const buy = Number(payload.buy ?? payload.entry_price)
      const tp = Number(payload.take_profit_price)
      const tpPct = Number(payload.take_profit_pct)
      const sl = Number(payload.stop_loss_price)
      const slPct = Number(payload.stop_loss_pct)
      const qty = Number(payload.quantity)
      if (Number.isFinite(buy)) entryPrice = buy
      if (Number.isFinite(tp)) tpPrice = tp
      if (Number.isFinite(tpPct)) takeProfitPct = tpPct
      if (Number.isFinite(sl)) slPrice = sl
      if (Number.isFinite(slPct)) stopLossPct = slPct
      if (Number.isFinite(qty)) quantity = qty
    }
    if (event.event_type === 'position_snapshot') {
      seenOrder = true
      filled = filled || Boolean(payload.position_id || positionId)
      orderId = String(payload.order_id || orderId || '') || null
      positionId = String(payload.position_id || positionId || '') || null
      symbol = String(payload.symbol || symbol || '')
      lastCheckAt = event.created_at
      const snapPnl = Number(payload.estimated_pnl)
      const snapPct = Number(payload.estimated_pnl_pct)
      if (Number.isFinite(snapPnl)) estimatedPnl = snapPnl
      if (Number.isFinite(snapPct)) estimatedPnlPct = snapPct
      const rem = Number(payload.remaining_to_target)
      const goal = Number(payload.goal_pct_complete)
      if (Number.isFinite(rem)) remainingToTarget = rem
      if (Number.isFinite(goal)) goalPctComplete = goal
      const tpDone = Number(payload.tp_pct_complete)
      const remTp = Number(payload.remaining_to_tp)
      if (Number.isFinite(tpDone)) tpPctComplete = tpDone
      if (Number.isFinite(remTp)) remainingToTp = remTp
      const slDone = Number(payload.sl_pct_complete)
      const remSl = Number(payload.remaining_to_sl)
      if (Number.isFinite(slDone)) slPctComplete = slDone
      if (Number.isFinite(remSl)) remainingToSl = remSl
      const buy = Number(payload.buy ?? payload.entry_price)
      const tp = Number(payload.take_profit_price)
      const tpPct = Number(payload.take_profit_pct)
      const sl = Number(payload.stop_loss_price)
      const slPct = Number(payload.stop_loss_pct)
      const cur = Number(payload.current_price)
      const qty = Number(payload.quantity)
      if (Number.isFinite(buy)) entryPrice = buy
      if (Number.isFinite(tp)) tpPrice = tp
      if (Number.isFinite(tpPct)) takeProfitPct = tpPct
      if (Number.isFinite(sl)) slPrice = sl
      if (Number.isFinite(slPct)) stopLossPct = slPct
      if (Number.isFinite(cur)) currentPrice = cur
      if (Number.isFinite(qty)) quantity = qty
    }
    if (
      event.event_type === 'attempt_completed'
      || event.event_type === 'order_failed'
      || event.event_type === 'force_close_started'
      || event.event_type === 'manual_close_requested'
    ) {
      if (payload.order_id) orderId = String(payload.order_id)
      if (payload.position_id) positionId = String(payload.position_id)
      if (payload.symbol) symbol = String(payload.symbol)
      lastCheckAt = event.created_at
      seenOrder = true
      if (
        event.event_type === 'attempt_completed'
        || event.event_type === 'force_close_started'
        || event.event_type === 'manual_close_requested'
      ) {
        positionClosed = true
      }
    }
  }

  if (!seenOrder && !orderId) return null

  if (livePnl?.pnl != null && Number.isFinite(livePnl.pnl)) {
    estimatedPnl = livePnl.pnl
  }
  if (livePnl?.pnlPct != null && Number.isFinite(livePnl.pnlPct)) {
    estimatedPnlPct = livePnl.pnlPct
  }
  if (livePnl?.currentPrice != null && Number.isFinite(livePnl.currentPrice)) {
    currentPrice = livePnl.currentPrice
  }

  const target = Number(session?.target_dollars)
  const cumulative = Number(session?.cumulative_pnl)
  if (Number.isFinite(target) && target > 0 && estimatedPnl != null) {
    const base = Number.isFinite(cumulative) ? cumulative : 0
    const projected = base + estimatedPnl
    remainingToTarget = Math.round((target - projected) * 100) / 100
    goalPctComplete = clampPct((projected / target) * 100)
  }

  // Prefer configured per-stock TP/SL % (session config) over any legacy raised attempt value.
  const configTp = Number(session?.config?.take_profit_pct)
  if (Number.isFinite(configTp) && configTp > 0) {
    takeProfitPct = configTp
  } else if (takeProfitPct == null && session?.config?.take_profit_pct != null) {
    takeProfitPct = Number(session.config.take_profit_pct)
  }
  const configSl = Number(session?.config?.stop_loss_pct)
  if (Number.isFinite(configSl) && configSl > 0) {
    stopLossPct = configSl
  } else if (stopLossPct == null && session?.config?.stop_loss_pct != null) {
    stopLossPct = Number(session.config.stop_loss_pct)
  }

  // Prefer live mark vs configured bracket prices for $ remaining (matches sticky Buy/TP/SL).
  // Fall back to %·notional when prices are missing.
  const liveTp = computeTpProgress({
    pnlPct: estimatedPnlPct,
    takeProfitPct,
    entry: entryPrice,
    tpPrice,
    current: currentPrice,
    quantity,
    pnl: estimatedPnl,
  })
  if (liveTp.tpPctComplete != null) tpPctComplete = liveTp.tpPctComplete
  if (liveTp.remainingToTp != null) remainingToTp = liveTp.remainingToTp
  // When we have both live mark and TP price, dollars-to-TP must use the bracket gap
  // (not capital·TP% which can disagree with the broker TP price / rounded qty).
  if (
    entryPrice != null && entryPrice > 0
    && tpPrice != null && tpPrice > 0
    && currentPrice != null
    && quantity != null && quantity > 0
  ) {
    remainingToTp = Math.round((tpPrice - currentPrice) * quantity * 100) / 100
    if (tpPrice !== entryPrice) {
      tpPctComplete = clampPct(((currentPrice - entryPrice) / (tpPrice - entryPrice)) * 100)
    }
  }
  const liveSl = computeSlProgress({
    pnlPct: estimatedPnlPct,
    stopLossPct,
    entry: entryPrice,
    slPrice,
    current: currentPrice,
    quantity,
    pnl: estimatedPnl,
  })
  if (liveSl.slPctComplete != null) slPctComplete = liveSl.slPctComplete
  if (liveSl.remainingToSl != null) remainingToSl = liveSl.remainingToSl
  if (
    entryPrice != null && entryPrice > 0
    && slPrice != null && slPrice > 0
    && currentPrice != null
    && quantity != null && quantity > 0
    && slPrice < entryPrice
  ) {
    remainingToSl = Math.round((currentPrice - slPrice) * quantity * 100) / 100
    slPctComplete = clampPct(((entryPrice - currentPrice) / (entryPrice - slPrice)) * 100)
  }

  const state = String(session?.state || '')
  let status = 'Order placed'
  if (positionClosed && state !== 'monitoring') status = 'Closed'
  else if (positionClosed) status = 'Closing…'
  else if (state === 'monitoring') status = filled || positionId ? 'Monitoring position' : 'Waiting for fill'
  else if (state === 'placing') status = 'Placing order'
  else if (state === 'evaluating') status = 'Evaluating close'
  else if (state === 'finished' || state === 'stopped') status = state === 'stopped' ? 'Stopped' : 'Closed'
  else if (filled || positionId) status = 'Filled'

  const openForClose = state === 'monitoring' && Boolean(positionId || orderId) && !positionClosed

  return {
    symbol: symbol || '—',
    orderId,
    positionId,
    status,
    lastCheckAt,
    filled: Boolean(filled || positionId),
    estimatedPnl,
    estimatedPnlPct,
    remainingToTarget,
    goalPctComplete,
    remainingToTp,
    tpPctComplete,
    takeProfitPct,
    remainingToSl,
    slPctComplete,
    stopLossPct,
    canClose: openForClose,
    positionClosed,
    entryPrice,
    tpPrice,
    slPrice,
    currentPrice,
  }
}

function OrderMonitorRow({
  row,
  closing,
  onClose,
}: {
  row: OrderMonitorRowData
  closing?: boolean
  onClose?: () => void
}) {
  const lastCheck = row.lastCheckAt
    ? new Date(row.lastCheckAt).toLocaleTimeString()
    : '—'
  const remaining = row.remainingToTarget
  const remainingLabel = remaining == null
    ? null
    : remaining > 0
      ? `${money(remaining)} to session`
      : remaining < 0
        ? `${money(Math.abs(remaining))} over session`
        : 'Session hit'
  const remTp = row.remainingToTp
  const tpRemainingLabel = remTp == null
    ? null
    : remTp > 0
      ? `${money(remTp)} to stock TP`
      : remTp < 0
        ? `${money(Math.abs(remTp))} over stock TP`
        : 'Stock TP hit'
  const remSl = row.remainingToSl
  const slRemainingLabel = remSl == null
    ? null
    : remSl > 0
      ? `${money(remSl)} to stock SL`
      : remSl < 0
        ? `${money(Math.abs(remSl))} past stock SL`
        : 'Stock SL hit'
  const showClose = Boolean(row.canClose && onClose && !closing && !row.positionClosed)
  const showProgress = remainingLabel != null
    || row.goalPctComplete != null
    || tpRemainingLabel != null
    || row.tpPctComplete != null
    || slRemainingLabel != null
    || row.slPctComplete != null
  return (
    <div className={`opc-order ${row.filled ? 'opc-order--live' : ''}`.trim()}>
      <div className="opc-order__head">
        <span className="opc-order__badge">{row.filled ? 'Filled' : 'Ordered'}</span>
        <strong className="opc-order__symbol">{row.symbol}</strong>
        <span className="opc-order__status">
          {closing ? 'Closing…' : row.status}
        </span>
        {row.estimatedPnl != null ? (
          <span className={`opc-order__pnl ${pnlClass(row.estimatedPnl)}`.trim()}>
            {money(row.estimatedPnl)}
            {row.estimatedPnlPct != null ? (
              <i className={pnlClass(row.estimatedPnlPct)}>{pct(row.estimatedPnlPct)}</i>
            ) : null}
          </span>
        ) : null}
        {showClose ? (
          <button
            type="button"
            className="opc-order__close"
            onClick={onClose}
          >
            Close position
          </button>
        ) : null}
      </div>
      {showProgress ? (
        <div className="opc-order__goal">
          {tpRemainingLabel ? (
            <span className={`opc-order__remaining opc-order__remaining--tp${remTp != null && remTp <= 0 ? ' opc-order__remaining--hit' : ''}`}>
              {tpRemainingLabel}
            </span>
          ) : null}
          {row.tpPctComplete != null ? (
            <span
              className="opc-order__goal-bar opc-order__goal-bar--tp"
              title={
                row.takeProfitPct != null
                  ? `${row.tpPctComplete}% of ${row.takeProfitPct}% stock take-profit`
                  : `${row.tpPctComplete}% of stock take-profit`
              }
            >
              <span
                className="opc-order__goal-fill opc-order__goal-fill--tp"
                style={{ width: `${Math.max(2, Math.min(100, row.tpPctComplete))}%` }}
              />
              <em>{row.tpPctComplete.toFixed(0)}% TP</em>
            </span>
          ) : null}
          {slRemainingLabel ? (
            <span className={`opc-order__remaining opc-order__remaining--sl${remSl != null && remSl <= 0 ? ' opc-order__remaining--hit-sl' : ''}`}>
              {slRemainingLabel}
            </span>
          ) : null}
          {row.slPctComplete != null ? (
            <span
              className="opc-order__goal-bar opc-order__goal-bar--sl"
              title={
                row.stopLossPct != null
                  ? `${row.slPctComplete}% of ${row.stopLossPct}% stock stop-loss`
                  : `${row.slPctComplete}% of stock stop-loss`
              }
            >
              <span
                className="opc-order__goal-fill opc-order__goal-fill--sl"
                style={{ width: `${Math.max(2, Math.min(100, row.slPctComplete))}%` }}
              />
              <em>{row.slPctComplete.toFixed(0)}% SL</em>
            </span>
          ) : null}
          {remainingLabel ? (
            <span className={`opc-order__remaining${remaining != null && remaining <= 0 ? ' opc-order__remaining--hit' : ''}`}>
              {remainingLabel}
            </span>
          ) : null}
          {row.goalPctComplete != null ? (
            <span className="opc-order__goal-bar" title={`${row.goalPctComplete}% of session $ target`}>
              <span
                className="opc-order__goal-fill"
                style={{ width: `${Math.max(2, Math.min(100, row.goalPctComplete))}%` }}
              />
              <em>{row.goalPctComplete.toFixed(0)}% session</em>
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="opc-order__ids">
        <span>
          <em>Order</em>
          <strong>{row.orderId || '—'}</strong>
        </span>
        <span>
          <em>Position</em>
          <strong>{row.positionId || 'pending'}</strong>
        </span>
        <span>
          <em>Last check</em>
          <strong>{lastCheck}</strong>
        </span>
      </div>
    </div>
  )
}

function AttemptHistoryRow({ attempt }: { attempt: Record<string, unknown> }) {
  const symbol = String(attempt.symbol || '—')
  const number = Number(attempt.attempt_number)
  const outcome = String(attempt.outcome || attempt.status || 'open')
  const pnl = Number(attempt.realized_pnl)
  const pnlPct = Number(attempt.realized_pnl_pct)
  const takeProfitPct = Number(attempt.take_profit_pct)
  const stopLossPct = Number(attempt.stop_loss_pct)
  const hasPnl = Number.isFinite(pnl)
  const hasPnlPct = Number.isFinite(pnlPct)
  const tpPct = Number.isFinite(takeProfitPct) && takeProfitPct > 0 && hasPnlPct
    ? clampPct((pnlPct / takeProfitPct) * 100)
    : null
  const slPct = Number.isFinite(stopLossPct) && stopLossPct > 0 && hasPnlPct
    ? clampPct((-pnlPct / stopLossPct) * 100)
    : null
  const done = Boolean(attempt.finished_at || attempt.outcome)
  if (!done && !hasPnl) return null
  return (
    <div className={`opc-attempt ${outcome === 'win' || outcome === 'take_profit' ? 'opc-attempt--win' : outcome === 'loss' || outcome === 'stop_loss' ? 'opc-attempt--loss' : ''}`.trim()}>
      <div className="opc-attempt__head">
        <span className="opc-attempt__badge">
          Attempt{Number.isFinite(number) ? ` ${number}` : ''}
        </span>
        <strong className="opc-attempt__symbol">{symbol}</strong>
        <span className="opc-attempt__outcome">{outcome.replace(/_/g, ' ')}</span>
        {hasPnl ? (
          <span className={`opc-attempt__pnl ${pnlClass(pnl)}`.trim()}>
            {money(pnl)}
            {hasPnlPct ? <i className={pnlClass(pnlPct)}>{pct(pnlPct)}</i> : null}
          </span>
        ) : null}
      </div>
      {tpPct != null || slPct != null ? (
        <div className="opc-order__goal">
          {tpPct != null ? (
            <span
              className="opc-order__goal-bar opc-order__goal-bar--tp"
              title={`${tpPct}% of ${takeProfitPct}% take-profit`}
            >
              <span
                className="opc-order__goal-fill opc-order__goal-fill--tp"
                style={{ width: `${Math.max(2, Math.min(100, tpPct))}%` }}
              />
              <em>{tpPct.toFixed(0)}% TP</em>
            </span>
          ) : null}
          {slPct != null ? (
            <span
              className="opc-order__goal-bar opc-order__goal-bar--sl"
              title={`${slPct}% of ${stopLossPct}% stop-loss`}
            >
              <span
                className="opc-order__goal-fill opc-order__goal-fill--sl"
                style={{ width: `${Math.max(2, Math.min(100, slPct))}%` }}
              />
              <em>{slPct.toFixed(0)}% SL</em>
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function StickyStockBar({
  payload,
  accountEnv,
  live,
}: {
  payload: Record<string, unknown>
  accountEnv: string
  live: { ltp: number | null; connected: boolean; streamStatus?: { label?: string } }
}) {
  const symbol = String(payload.symbol || '—')
  const name = String(payload.name || symbol)
  const logo = typeof payload.logo50x50 === 'string'
    ? payload.logo50x50
    : typeof payload.logo35x35 === 'string'
      ? payload.logo35x35
      : null
  const entry = Number(payload.buy ?? payload.entry_price)
  const livePrice = live.ltp != null && Number.isFinite(live.ltp) ? live.ltp : null
  const current = livePrice ?? Number(payload.current_price ?? payload.buy ?? payload.entry_price)
  const qty = Number(payload.quantity)
  const estPnl = Number.isFinite(entry) && Number.isFinite(current) && Number.isFinite(qty) && qty > 0
    ? (current - entry) * qty
    : Number(payload.estimated_pnl ?? payload.profit_amount)
  const estPnlPct = Number.isFinite(entry) && entry > 0 && Number.isFinite(current)
    ? ((current - entry) / entry) * 100
    : Number(payload.estimated_pnl_pct ?? payload.profit_pct)

  const prevLiveRef = useRef<number | null>(null)
  const [tickDir, setTickDir] = useState<'up' | 'down' | ''>('')

  useEffect(() => {
    prevLiveRef.current = null
    setTickDir('')
  }, [symbol])

  useEffect(() => {
    if (livePrice == null) {
      setTickDir('')
      return
    }
    const prev = prevLiveRef.current
    prevLiveRef.current = livePrice
    if (prev == null || prev === livePrice) return
    setTickDir(livePrice > prev ? 'up' : 'down')
  }, [livePrice])

  const vsEntry = Number.isFinite(entry) && Number.isFinite(current) && entry > 0
    ? current - entry
    : null
  const liveTone = tickDir === 'up'
    ? 'opc-pos'
    : tickDir === 'down'
      ? 'opc-neg'
      : vsEntry != null && vsEntry !== 0
        ? pnlClass(vsEntry)
        : ''

  return (
    <div className="opc-sticky">
      <span className="opc-sticky__logo">
        <SymbolLogo
          symbol={symbol}
          visual={logo ? { ticker: symbol, logo50x50: logo, logo35x35: logo } : null}
        />
      </span>
      <div className="opc-sticky__id">
        <strong>{symbol}</strong>
        <span>{name}</span>
      </div>
      <div className="opc-sticky__metrics">
        <span className="opc-pill">
          <em>Live</em>
          <strong className={`opc-sticky__live ${liveTone}`.trim()}>{money(current)}</strong>
          <i>{live.connected ? 'ws' : 'poll'}</i>
        </span>
        <span className="opc-pill">
          <em>Buy</em>
          <strong>{money(entry)}</strong>
        </span>
        <span className="opc-pill">
          <em>TP</em>
          <strong>{money(payload.take_profit_price)}</strong>
        </span>
        <span className="opc-pill">
          <em>SL</em>
          <strong>{money(payload.stop_loss_price)}</strong>
        </span>
        <span className={`opc-pill opc-pill--pnl ${pnlClass(estPnl)}`.trim()}>
          <em>P&amp;L</em>
          <strong className={pnlClass(estPnl)}>{money(estPnl)}</strong>
          <i className={pnlClass(estPnlPct)}>{pct(estPnlPct)}</i>
        </span>
      </div>
      <div className="opc-sticky__meta">
        {payload.attempt_number != null
          ? `${String(payload.attempt_number)}/${String(payload.max_attempts ?? '—')}`
          : accountEnv.toUpperCase()}
      </div>
    </div>
  )
}

export default function OnePercentSessionWorkspace({
  sessionId,
  onSessionUpdate,
}: Props) {
  const [detail, setDetail] = useState<OnePercentSessionDetail | null>(null)
  const [events, setEvents] = useState<OnePercentSessionEvent[]>([])
  const [error, setError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [closingPosition, setClosingPosition] = useState(false)
  const [locallyClosedIds, setLocallyClosedIds] = useState(() => new Set<string>())
  const autoCloseArmedRef = useRef(true)
  const autoCloseInFlightRef = useRef(false)

  const load = useCallback(async () => {
    const next = await getOnePercentSession(sessionId)
    setDetail(next)
    setEvents(next.events || [])
    onSessionUpdate?.(next)
  }, [onSessionUpdate, sessionId])

  useEffect(() => {
    let cancelled = false
    void load().catch(err => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load session')
    })
    return () => {
      cancelled = true
    }
  }, [load])

  useEffect(() => {
    setLocallyClosedIds(new Set())
    setClosingPosition(false)
    autoCloseArmedRef.current = true
    autoCloseInFlightRef.current = false
  }, [sessionId])

  // New attempt → drop sticky "Closing…" from the previous position.
  useEffect(() => {
    setLocallyClosedIds(new Set())
    setClosingPosition(false)
    autoCloseArmedRef.current = true
    autoCloseInFlightRef.current = false
  }, [detail?.active_attempt_id])

  useEffect(() => {
    if (!detail || isTerminalOnePercentState(detail.state)) return
    let cancelled = false
    let sinceId = events.reduce((max, event) => Math.max(max, event.id), 0)

    const tick = async () => {
      try {
        const [session, fresh] = await Promise.all([
          getOnePercentSession(sessionId),
          pollOnePercentSessionEvents(sessionId, sinceId),
        ])
        if (cancelled) return
        setDetail(session)
        onSessionUpdate?.(session)
        if (fresh.length) {
          setEvents(prev => {
            const known = new Set(prev.map(item => item.id))
            const merged = [...prev]
            for (const event of fresh) {
              if (!known.has(event.id)) merged.push(event)
            }
            return merged
          })
          sinceId = Math.max(sinceId, ...fresh.map(item => item.id))
        }
      } catch {
        // keep polling
      }
    }

    const timer = window.setInterval(() => {
      void tick()
    }, 2500)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [detail?.state, events, onSessionUpdate, sessionId])

  const pinned = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (
        event.event_type === 'position_snapshot'
        || event.event_type === 'entry_filled'
        || event.event_type === 'order_placed'
        || event.event_type === 'order_configured'
        || event.event_type === 'stock_selected'
      ) {
        return {
          ...event,
          payload: asRecord(event.payload),
        }
      }
    }
    return null
  }, [events])

  const feedSymbol = String(pinned?.payload.symbol || detail?.active_symbol || '')
  const feedToken = useMemo(() => {
    const fromPayload = pinned?.payload.symboltoken
    if (typeof fromPayload === 'string' && fromPayload) return fromPayload
    const attempt = (detail?.attempts || []).find(row => {
      const item = asRecord(row)
      return String(item.symbol || '').toUpperCase() === feedSymbol.toUpperCase()
    })
    const token = attempt ? asRecord(attempt).symboltoken : null
    return typeof token === 'string' ? token : null
  }, [detail?.attempts, feedSymbol, pinned?.payload.symboltoken])

  const live = useCandidateChartLive({
    symbol: feedSymbol,
    token: feedToken,
    exchange: 'ETORO',
    broker: 'etoro',
    accountEnv: (detail?.account_env === 'live' ? 'live' : 'demo'),
    enabled: Boolean(feedSymbol) && !isTerminalOnePercentState(detail?.state),
  })

  const pickRows = useMemo(() => buildPickStatusRows(events), [events])

  const liveOrderPnl = useMemo(() => {
    const payload = pinned?.payload
    if (!payload) {
      return {
        pnl: null as number | null,
        pnlPct: null as number | null,
        currentPrice: null as number | null,
      }
    }
    const entry = Number(payload.buy ?? payload.entry_price)
    const qty = Number(payload.quantity)
    const livePrice = live.ltp != null && Number.isFinite(live.ltp) ? live.ltp : null
    const current = livePrice ?? Number(payload.current_price ?? payload.buy ?? payload.entry_price)
    if (Number.isFinite(entry) && Number.isFinite(current) && Number.isFinite(qty) && qty > 0) {
      const pnl = (current - entry) * qty
      const pnlPct = entry > 0 ? ((current - entry) / entry) * 100 : null
      return {
        pnl,
        pnlPct,
        currentPrice: Number.isFinite(current) ? current : null,
      }
    }
    const snap = Number(payload.estimated_pnl)
    const snapPct = Number(payload.estimated_pnl_pct)
    return {
      pnl: Number.isFinite(snap) ? snap : null,
      pnlPct: Number.isFinite(snapPct) ? snapPct : null,
      currentPrice: Number.isFinite(current) ? current : null,
    }
  }, [live.ltp, pinned?.payload])

  const orderRow = useMemo(() => {
    const row = buildOrderMonitorRow(events, detail, liveOrderPnl)
    if (!row) return null
    const pid = row.positionId ? String(row.positionId) : ''
    const activePid = detail?.active_position_id ? String(detail.active_position_id) : ''
    // Only treat local close sticky state as belonging to the *current* open position.
    if (pid && activePid && pid === activePid && locallyClosedIds.has(pid)) {
      return {
        ...row,
        canClose: false,
        positionClosed: true,
        status: detail?.state === 'monitoring' ? 'Closing…' : (row.positionClosed ? row.status : 'Closed'),
      }
    }
    return row
  }, [detail, events, liveOrderPnl, locallyClosedIds])

  const finishedAttempts = useMemo(
    () => (detail?.attempts || [])
      .map(row => asRecord(row))
      .filter(row => Boolean(row.finished_at || row.outcome || row.realized_pnl != null)),
    [detail?.attempts],
  )

  const handleStop = useCallback(async () => {
    setStopping(true)
    setError('')
    try {
      const next = await stopOnePercentSession(sessionId)
      setDetail(next)
      setEvents(next.events || [])
      onSessionUpdate?.(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop session')
    } finally {
      setStopping(false)
    }
  }, [onSessionUpdate, sessionId])

  const handleClosePosition = useCallback(async (reason = '1% manual close') => {
    if (!detail) return
    const positionId = String(
      orderRow?.positionId || detail.active_position_id || '',
    ).trim()
    if (!positionId) {
      setError('No broker position id to close')
      return
    }
    // Hide Close immediately so a second click cannot fire.
    setLocallyClosedIds(prev => {
      const next = new Set(prev)
      next.add(positionId)
      return next
    })
    setClosingPosition(true)
    setError('')
    try {
      // Broker close only — API returns on ACK; history settle is background.
      const result = await closeEtoroPosition(positionId, detail.account_env, {
        units: orderRow?.quantity ?? null,
        instrumentId: feedToken,
        notify: {
          source: 'positions',
          ticker: orderRow?.symbol || detail.active_symbol || undefined,
          close_reason: reason,
        },
      })
      logCloseEtoroExchange('1pc-manual', result)
      watchCloseSettlement(result, orderRow?.symbol || detail.active_symbol || positionId)

      // Unlock UI as soon as the broker ACK lands — do not wait on engine notify.
      setClosingPosition(false)
      autoCloseInFlightRef.current = false

      // Engine flag only (skip second eToro close). Fire-and-forget.
      void closeOnePercentPosition(sessionId, reason, { brokerAlreadyClosed: true })
        .then(next => {
          setDetail(next)
          setEvents(next.events || [])
          onSessionUpdate?.(next)
        })
        .catch(notifyErr => {
          const msg = notifyErr instanceof Error ? notifyErr.message : ''
          if (!/not found/i.test(msg)) {
            console.warn('[1pc] close-position notify failed', notifyErr)
          }
          void getOnePercentSession(sessionId)
            .then(refreshed => {
              setDetail(refreshed)
              setEvents(refreshed.events || [])
              onSessionUpdate?.(refreshed)
            })
            .catch(() => {})
        })
    } catch (err) {
      setLocallyClosedIds(prev => {
        const next = new Set(prev)
        next.delete(positionId)
        return next
      })
      autoCloseArmedRef.current = true
      setError(err instanceof Error ? err.message : 'Failed to close position')
      setClosingPosition(false)
      autoCloseInFlightRef.current = false
    }
  }, [detail, feedToken, onSessionUpdate, orderRow, sessionId])

  // Auto-close when this stock's configured take-profit % is reached (frontend).
  useEffect(() => {
    if (!detail || detail.state !== 'monitoring') return
    if (!orderRow?.canClose || closingPosition) return
    if (!autoCloseArmedRef.current || autoCloseInFlightRef.current) return

    const tpPct = Number(detail.config?.take_profit_pct ?? orderRow.takeProfitPct)
    const pnlPct = liveOrderPnl.pnlPct
    const hitByPct = Number.isFinite(tpPct) && tpPct > 0
      && pnlPct != null && Number.isFinite(pnlPct)
      && pnlPct >= tpPct * 0.999

    const entry = orderRow.entryPrice
    const tpPrice = orderRow.tpPrice
    const current = live.ltp != null && Number.isFinite(live.ltp)
      ? live.ltp
      : orderRow.currentPrice
    // Soft price hit must stay meaningfully above entry (mirrors engine).
    let hitByPrice = false
    if (
      entry != null && entry > 0
      && tpPrice != null && tpPrice > entry
      && current != null && Number.isFinite(current)
    ) {
      const softTp = Math.max(tpPrice * 0.999, entry + (tpPrice - entry) * 0.5)
      hitByPrice = current >= softTp
    }

    if (!hitByPct && !hitByPrice) return

    autoCloseArmedRef.current = false
    autoCloseInFlightRef.current = true
    void handleClosePosition('1% take-profit')
  }, [
    closingPosition,
    detail,
    handleClosePosition,
    live.ltp,
    liveOrderPnl.pnlPct,
    orderRow,
  ])
  if (!detail) {
    return <div className="am-chat-empty">{error || 'Loading 1% session…'}</div>
  }

  return (
    <div className="opc-workspace">
      <header className="opc-workspace__header opc-workspace__header--compact">
        <div className="opc-workspace__left">
          <div>
            <strong>{onePercentSessionLabel(detail)}</strong>
            <span>
              {detail.account_env.toUpperCase()} · {detail.state}
              {detail.active_symbol ? ` · ${detail.active_symbol}` : ''}
            </span>
          </div>
        </div>
        <div className="opc-workspace__stats">
          <div>
            <span>P&amp;L</span>
            <strong className={pnlClass(detail.cumulative_pnl)}>{money(detail.cumulative_pnl)}</strong>
          </div>
          <div>
            <span>Target</span>
            <strong>{money(detail.target_dollars)}</strong>
          </div>
          <div>
            <span>Tries</span>
            <strong>
              {detail.attempt_count}/{detail.max_attempts}
            </strong>
          </div>
          {!isTerminalOnePercentState(detail.state) ? (
            <button type="button" className="opc-workspace__stop" disabled={stopping} onClick={() => void handleStop()}>
              {stopping ? '…' : 'Stop'}
            </button>
          ) : null}
        </div>
      </header>

      {error ? <div className="opc-starter__error">{error}</div> : null}

      {pinned ? (
        <div className="opc-workspace__pinned">
          <StickyStockBar
            payload={pinned.payload}
            accountEnv={detail.account_env}
            live={live}
          />
        </div>
      ) : null}

      <div className="opc-workspace__timeline opc-workspace__timeline--rows">
        {pickRows.length || orderRow ? (
          <>
            {pickRows.map(row => <PickStatusRow key={row.key} row={row} />)}
            {orderRow ? (
              <OrderMonitorRow
                row={orderRow}
                closing={closingPosition}
                onClose={() => void handleClosePosition()}
              />
            ) : null}
          </>
        ) : (
          <div className="am-empty-note">Waiting for a pick…</div>
        )}
      </div>

      {finishedAttempts.length ? (
        <details className="opc-attempts-panel">
          <summary className="opc-attempts-panel__summary">
            <span>Attempts</span>
            <em>{finishedAttempts.length}</em>
          </summary>
          <div className="opc-attempts-panel__body">
            {finishedAttempts.map(attempt => (
              <AttemptHistoryRow
                key={String(attempt.id || `${attempt.symbol}-${attempt.attempt_number}`)}
                attempt={attempt}
              />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  )
}
