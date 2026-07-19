import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import SymbolLogo from '@/components/SymbolLogo'
import { useCandidateChartLive } from '@/hooks/useCandidateChartLive'
import {
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
}

function buildOrderMonitorRow(
  events: OnePercentSessionEvent[],
  session: OnePercentSession | null,
): OrderMonitorRowData | null {
  let orderId: string | null = session?.active_order_id ? String(session.active_order_id) : null
  let positionId: string | null = session?.active_position_id ? String(session.active_position_id) : null
  let symbol = String(session?.active_symbol || '')
  let lastCheckAt: string | null = null
  let filled = false
  let seenOrder = false

  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.event_type === 'order_placed') {
      seenOrder = true
      orderId = String(payload.order_id || orderId || '') || null
      symbol = String(payload.symbol || symbol || '')
      if (!lastCheckAt) lastCheckAt = event.created_at
    }
    if (event.event_type === 'entry_filled') {
      seenOrder = true
      filled = true
      orderId = String(payload.order_id || orderId || '') || null
      positionId = String(payload.position_id || positionId || '') || null
      symbol = String(payload.symbol || symbol || '')
      lastCheckAt = event.created_at
    }
    if (event.event_type === 'position_snapshot') {
      seenOrder = true
      filled = filled || Boolean(payload.position_id || positionId)
      orderId = String(payload.order_id || orderId || '') || null
      positionId = String(payload.position_id || positionId || '') || null
      symbol = String(payload.symbol || symbol || '')
      lastCheckAt = event.created_at
    }
    if (event.event_type === 'attempt_completed' || event.event_type === 'order_failed') {
      if (payload.order_id) orderId = String(payload.order_id)
      if (payload.position_id) positionId = String(payload.position_id)
      if (payload.symbol) symbol = String(payload.symbol)
      lastCheckAt = event.created_at
      seenOrder = true
    }
  }

  if (!seenOrder && !orderId) return null

  const state = String(session?.state || '')
  let status = 'Order placed'
  if (state === 'monitoring') status = filled || positionId ? 'Monitoring position' : 'Waiting for fill'
  else if (state === 'placing') status = 'Placing order'
  else if (state === 'evaluating') status = 'Evaluating close'
  else if (state === 'finished' || state === 'stopped') status = state === 'stopped' ? 'Stopped' : 'Closed'
  else if (filled || positionId) status = 'Filled'

  return {
    symbol: symbol || '—',
    orderId,
    positionId,
    status,
    lastCheckAt,
    filled: Boolean(filled || positionId),
  }
}

function OrderMonitorRow({ row }: { row: OrderMonitorRowData }) {
  const lastCheck = row.lastCheckAt
    ? new Date(row.lastCheckAt).toLocaleTimeString()
    : '—'
  return (
    <div className={`opc-order ${row.filled ? 'opc-order--live' : ''}`.trim()}>
      <div className="opc-order__head">
        <span className="opc-order__badge">{row.filled ? 'Filled' : 'Ordered'}</span>
        <strong className="opc-order__symbol">{row.symbol}</strong>
        <span className="opc-order__status">{row.status}</span>
      </div>
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
  const orderRow = useMemo(() => buildOrderMonitorRow(events, detail), [detail, events])

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
            {orderRow ? <OrderMonitorRow row={orderRow} /> : null}
          </>
        ) : (
          <div className="am-empty-note">Waiting for a pick…</div>
        )}
      </div>
    </div>
  )
}
