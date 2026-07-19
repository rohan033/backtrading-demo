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

function absPct(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num)) return '—'
  return `${Math.abs(num).toFixed(2)}%`
}

function pnlClass(value: unknown): string {
  const num = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(num) || num === 0) return ''
  return num > 0 ? 'opc-pos' : 'opc-neg'
}

function eventPhase(eventType: string): string {
  switch (eventType) {
    case 'session_created':
      return 'Created'
    case 'verifying_balance':
      return 'Balance'
    case 'balance_verified':
      return 'Balance'
    case 'screening_started':
      return 'Search'
    case 'candidates_found':
      return 'Candidates'
    case 'stock_selected':
      return 'Selected'
    case 'order_configured':
      return 'Bracket'
    case 'order_placed':
      return 'Ordered'
    case 'entry_filled':
      return 'Filled'
    case 'position_snapshot':
      return 'Live'
    case 'attempt_completed':
      return 'Attempt'
    case 'session_finished':
      return 'Finished'
    case 'order_failed':
    case 'screening_failed':
      return 'Error'
    default:
      return eventType.replace(/_/g, ' ')
  }
}

function eventStatusLine(event: OnePercentSessionEvent): string {
  const payload = asRecord(event.payload)
  switch (event.event_type) {
    case 'session_created': {
      const config = asRecord(payload.config)
      return `${String(payload.account_env || 'demo').toUpperCase()} · capital ${money(config.capital)} · target ${pct(config.target_pct)} · TP ${absPct(config.take_profit_pct)} / SL ${absPct(config.stop_loss_pct)}`
    }
    case 'verifying_balance':
      return `Need ${money(payload.required_capital)} on ${String(payload.account_env || 'demo').toUpperCase()}`
    case 'balance_verified':
      return `Available ${money(payload.available_cash)} · need ${money(payload.required_capital)}${payload.sufficient === true ? ' · OK' : ''}`
    case 'screening_started':
      return `Attempt ${String(payload.attempt_number ?? '—')}/${String(payload.max_attempts ?? '—')} · TradingView S&P/Nasdaq`
    case 'candidates_found': {
      const candidates = Array.isArray(payload.candidates) ? payload.candidates : []
      const top = candidates.slice(0, 4).map(item => String(asRecord(item).symbol || '')).filter(Boolean)
      return `${String(payload.query_name || 'Screener')} · ${String(payload.total_found ?? candidates.length)} hits${top.length ? ` · ${top.join(', ')}` : ''}`
    }
    case 'stock_selected':
      return `${String(payload.symbol || '—')} @ ${money(payload.current_price)} · score ${payload.score != null ? Number(payload.score).toFixed(1) : '—'}`
    case 'order_configured':
      return `${String(payload.symbol || '—')} · est entry ${money(payload.entry_price)} · TP ${money(payload.take_profit_price)} (${absPct(payload.take_profit_pct)}) · SL ${money(payload.stop_loss_price)} (${absPct(payload.stop_loss_pct)})`
    case 'order_placed':
      return `${String(payload.symbol || '—')} · qty ${String(payload.quantity ?? '—')} · est entry ${money(payload.entry_price)} · order ${String(payload.order_id || '—')}`
    case 'entry_filled':
      return `${String(payload.symbol || '—')} · buy ${money(payload.buy ?? payload.entry_price)} · qty ${String(payload.quantity ?? '—')} · position filled`
    case 'position_snapshot':
      return `${String(payload.symbol || '—')} · ${money(payload.current_price)} · buy ${money(payload.buy ?? payload.entry_price)} · P&L ${money(payload.estimated_pnl)} (${pct(payload.estimated_pnl_pct)})`
    case 'attempt_completed':
      return `${String(payload.symbol || '—')} · buy ${money(payload.buy ?? payload.entry_price)} → sell ${money(payload.sell)} · ${money(payload.profit_amount)} (${pct(payload.profit_pct)}) · ${String(payload.close_reason || 'closed')}`
    case 'session_finished':
      return `${String(payload.outcome || 'finished')} · P&L ${money(payload.cumulative_pnl)} vs target ${money(payload.target_dollars)} · ${String(payload.attempt_count ?? '—')} attempts${payload.reason ? ` · ${String(payload.reason)}` : ''}`
    case 'order_failed':
    case 'screening_failed':
      return String(payload.error || 'Failed')
    default: {
      const entries = Object.entries(payload).slice(0, 4)
      if (!entries.length) return '—'
      return entries.map(([key, value]) => `${key}=${typeof value === 'object' ? '…' : String(value)}`).join(' · ')
    }
  }
}

function EventRow({ event }: { event: OnePercentSessionEvent }) {
  const tone = event.event_type.includes('fail') || event.event_type === 'session_finished'
    ? event.event_type.includes('fail')
      ? 'opc-row--error'
      : 'opc-row--final'
    : event.event_type === 'position_snapshot' || event.event_type === 'order_placed'
      ? 'opc-row--live'
      : ''
  return (
    <div className={`opc-row ${tone}`.trim()}>
      <span className="opc-row__phase">{eventPhase(event.event_type)}</span>
      <span className="opc-row__status">{eventStatusLine(event)}</span>
      <span className="opc-row__time">{new Date(event.created_at).toLocaleTimeString()}</span>
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
        <span>
          Live{' '}
          <strong className={`opc-sticky__live ${liveTone}`.trim()}>
            {money(current)}
          </strong>
          {live.connected ? <em>ws</em> : <em>poll</em>}
        </span>
        <span>Buy <strong>{money(entry)}</strong></span>
        <span>TP <strong>{money(payload.take_profit_price)}</strong></span>
        <span>SL <strong>{money(payload.stop_loss_price)}</strong></span>
        <span className={pnlClass(estPnl)}>
          P&amp;L <strong className={pnlClass(estPnl)}>{money(estPnl)}</strong>{' '}
          <em className={pnlClass(estPnlPct)}>{pct(estPnlPct)}</em>
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

  const timelineEvents = useMemo(() => {
    let latestSnapshotId: number | null = null
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].event_type === 'position_snapshot') {
        latestSnapshotId = events[i].id
        break
      }
    }
    return events.filter(event => (
      event.event_type !== 'position_snapshot' || event.id === latestSnapshotId
    ))
  }, [events])

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
        {timelineEvents.length ? (
          timelineEvents.map(event => <EventRow key={event.id} event={event} />)
        ) : (
          <div className="am-empty-note">Waiting for session events…</div>
        )}
      </div>
    </div>
  )
}
