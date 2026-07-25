import { useCallback, useEffect, useRef, useState } from 'react'

import {
  agenticApiUnavailable,
  agenticSessionLabel,
  closeAgenticPosition,
  getAgenticSession,
  listAgenticSessionEvents,
  listAgenticSessionPositions,
  listAgenticSuggestions,
  stopAgenticSession,
  type AgenticSession,
  type AgenticSessionEvent,
  type AgenticSessionPosition,
  type AgenticSuggestion,
} from '@/lib/agenticSessions'
import { formatDbTimestamp, formatRelativeTimestamp } from '@/lib/datetime'
import './AgenticSessions.css'

const EVENTS_POLL_MS = 4000
const POSITIONS_POLL_MS = 4000
const SESSION_POLL_MS = 5000
const SUGGESTIONS_POLL_MS = 10000

function formatMoney(value: number): string {
  return `$${Math.abs(value) >= 1000
    ? Math.round(value).toLocaleString()
    : value.toFixed(2)}`
}

function formatSignedMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

function formatWinRate(value: number | null): string {
  if (value == null) return '—'
  const pct = value <= 1 ? value * 100 : value
  return `${pct.toFixed(0)}%`
}

function pnlClass(value: number): string {
  if (value > 0) return 'ags-pos'
  if (value < 0) return 'ags-neg'
  return ''
}

function LiveClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <span className="ags-clock">
      {now.toLocaleTimeString(undefined, { hour12: false })}
    </span>
  )
}

export default function AgenticSessionWorkspace({
  sessionId,
  onBack,
}: {
  sessionId: string
  onBack: () => void
}) {
  const [session, setSession] = useState<AgenticSession | null>(null)
  const [sessionError, setSessionError] = useState('')
  const [actionError, setActionError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [promptExpanded, setPromptExpanded] = useState(false)

  const isRunning = session?.status === 'running'

  const loadSession = useCallback(async () => {
    try {
      setSession(await getAgenticSession(sessionId))
      setSessionError('')
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load session'
      setSessionError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable — the backend has not started yet (make dev).'
        : message)
    }
  }, [sessionId])

  useEffect(() => {
    void loadSession()
  }, [loadSession])

  useEffect(() => {
    if (!isRunning) return
    const timer = window.setInterval(() => void loadSession(), SESSION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [isRunning, loadSession])

  const handleStop = useCallback(async () => {
    if (!session) return
    if (!window.confirm(`Stop ${agenticSessionLabel(session)}? The agent will place no further trades.`)) {
      return
    }
    setStopping(true)
    setActionError('')
    try {
      setSession(await stopAgenticSession(session.id))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to stop session')
    } finally {
      setStopping(false)
    }
  }, [session])

  if (sessionError && !session) {
    return (
      <div className="ags-root">
        <div className="ags-error">{sessionError}</div>
        <button type="button" className="ags-btn ags-back-btn" onClick={onBack}>
          ← Back to sessions
        </button>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="ags-root">
        <div className="ags-empty">Loading session…</div>
      </div>
    )
  }

  const stats = session.stats

  return (
    <div className="ags-root ags-workspace">
      <header className="ags-header">
        <div className="ags-header__row">
          <button type="button" className="ags-back-link" onClick={onBack}>
            ← Sessions
          </button>
          <strong className="ags-header__name" title={session.id}>
            {agenticSessionLabel(session)}
          </strong>
          <span className={`ags-env-badge ags-env-badge--${session.account_env}`}>
            {session.account_env}
          </span>
          <span className={`ags-status-pill ags-status-pill--${session.status}`}>
            {session.status}
          </span>
          <LiveClock />
          {isRunning ? (
            <button
              type="button"
              className="ags-stop-btn"
              onClick={() => void handleStop()}
              disabled={stopping}
            >
              {stopping ? 'Stopping…' : 'STOP'}
            </button>
          ) : null}
        </div>
        {session.prompt ? (
          <div
            className={`ags-header__prompt${promptExpanded ? ' ags-header__prompt--expanded' : ''}`}
            title={promptExpanded ? undefined : session.prompt}
            role="button"
            tabIndex={0}
            onClick={() => setPromptExpanded(expanded => !expanded)}
            onKeyDown={event => {
              if (event.key === 'Enter' || event.key === ' ') {
                setPromptExpanded(expanded => !expanded)
              }
            }}
          >
            <span className="ags-header__prompt-label">Prompt</span>
            <span className="ags-header__prompt-text">{session.prompt}</span>
          </div>
        ) : null}
        {session.status === 'stopped' ? (
          <div className="ags-stopped-banner">
            Session stopped
            {session.stopped_at ? ` ${formatRelativeTimestamp(session.stopped_at)}` : ''}
            {session.stop_reason ? ` — ${session.stop_reason}` : ''}
          </div>
        ) : null}
        {actionError ? <div className="ags-error">{actionError}</div> : null}

        <div className="ags-stats">
          <div className="ags-stat">
            <span className="ags-stat__label">Trades</span>
            <span className="ags-stat__val">{stats.trades_placed}</span>
          </div>
          <div className="ags-stat">
            <span className="ags-stat__label">Realized PnL</span>
            <span className={`ags-stat__val ${pnlClass(stats.realized_pnl)}`}>
              {formatSignedMoney(stats.realized_pnl)}
            </span>
          </div>
          <div className="ags-stat">
            <span className="ags-stat__label">Unrealized PnL</span>
            <span className={`ags-stat__val ${pnlClass(stats.unrealized_pnl)}`}>
              {formatSignedMoney(stats.unrealized_pnl)}
            </span>
          </div>
          <div className="ags-stat">
            <span className="ags-stat__label">Invested</span>
            <span className="ags-stat__val">{formatMoney(stats.invested)}</span>
          </div>
          <div className="ags-stat">
            <span className="ags-stat__label">Win rate</span>
            <span className="ags-stat__val">{formatWinRate(stats.win_rate)}</span>
          </div>
          <div className="ags-stat">
            <span className="ags-stat__label">Open positions</span>
            <span className="ags-stat__val">{stats.open_positions}</span>
          </div>
        </div>
      </header>

      <div className="ags-body">
        <AgenticEventTimeline sessionId={sessionId} live={isRunning} />
        <div className="ags-right">
          <AgenticPositionsPanel sessionId={sessionId} live={isRunning} />
          <AgenticSuggestionsPanel live={isRunning} />
        </div>
      </div>
    </div>
  )
}

/* ── Event timeline ── */

function AgenticEventTimeline({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [events, setEvents] = useState<AgenticSessionEvent[]>([])
  const [error, setError] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const afterIdRef = useRef(0)

  const poll = useCallback(async () => {
    try {
      const batch = await listAgenticSessionEvents(sessionId, afterIdRef.current)
      setError('')
      if (batch.length === 0) return
      afterIdRef.current = batch[batch.length - 1].id
      setEvents(prev => {
        const seen = new Set(prev.map(event => event.id))
        const fresh = batch.filter(event => !seen.has(event.id))
        return fresh.length ? [...prev, ...fresh] : prev
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load events')
    }
  }, [sessionId])

  useEffect(() => {
    void poll()
  }, [poll])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void poll(), EVENTS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [live, poll])

  return (
    <section className="ags-panel ags-panel--events">
      <div className="ags-panel__head">
        <h3 className="ags-panel__title">Event timeline</h3>
        <span className="ags-panel__count">{events.length}</span>
      </div>
      <div className="ags-panel__body">
        {error ? <div className="ags-error ags-error--inline">{error}</div> : null}
        {events.length === 0 && !error ? (
          <div className="ags-empty">No events yet.</div>
        ) : (
          <ul className="ags-events">
            {[...events].reverse().map(event => {
              const expanded = expandedId === event.id
              const metaEntries = Object.entries(event.meta || {})
              return (
                <li key={event.id} className="ags-event">
                  <button
                    type="button"
                    className="ags-event__row"
                    onClick={() => setExpandedId(expanded ? null : event.id)}
                  >
                    <span className={`ags-event__dot ags-event__dot--${event.type}`} />
                    <span className="ags-event__time" title={formatDbTimestamp(event.ts)}>
                      {formatRelativeTimestamp(event.ts)}
                    </span>
                    {event.ticker ? (
                      <strong className="ags-event__ticker">{event.ticker}</strong>
                    ) : null}
                    <span className="ags-event__text">{event.text}</span>
                  </button>
                  {expanded ? (
                    <dl className="ags-event__meta">
                      <div className="ags-event__meta-row">
                        <dt>type</dt>
                        <dd>{event.type}</dd>
                      </div>
                      <div className="ags-event__meta-row">
                        <dt>at</dt>
                        <dd>{formatDbTimestamp(event.ts)}</dd>
                      </div>
                      {metaEntries.map(([key, value]) => (
                        <div key={key} className="ags-event__meta-row">
                          <dt>{key}</dt>
                          <dd>
                            {typeof value === 'object' && value !== null
                              ? JSON.stringify(value)
                              : String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </section>
  )
}

/* ── Positions table ── */

function AgenticPositionsPanel({ sessionId, live }: { sessionId: string; live: boolean }) {
  const [positions, setPositions] = useState<AgenticSessionPosition[]>([])
  const [error, setError] = useState('')
  const [closingId, setClosingId] = useState('')
  const prevPricesRef = useRef<Record<string, number>>({})
  const flashTimerRef = useRef<number | null>(null)
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({})

  const poll = useCallback(async () => {
    try {
      const rows = await listAgenticSessionPositions(sessionId)
      setError('')
      const prev = prevPricesRef.current
      const flashPatch: Record<string, 'up' | 'down'> = {}
      for (const row of rows) {
        const before = prev[row.id]
        if (before != null && row.current_price !== before) {
          flashPatch[row.id] = row.current_price > before ? 'up' : 'down'
        }
        prev[row.id] = row.current_price
      }
      setPositions(rows)
      if (Object.keys(flashPatch).length) {
        setFlash(flashPatch)
        if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
        flashTimerRef.current = window.setTimeout(() => setFlash({}), 650)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions')
    }
  }, [sessionId])

  useEffect(() => {
    void poll()
    return () => {
      if (flashTimerRef.current != null) window.clearTimeout(flashTimerRef.current)
    }
  }, [poll])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void poll(), POSITIONS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [live, poll])

  const handleClose = useCallback(async (position: AgenticSessionPosition) => {
    if (!window.confirm(`Close ${position.ticker} (${position.units} units) at market?`)) return
    setClosingId(position.id)
    setError('')
    try {
      const updated = await closeAgenticPosition(sessionId, position.id)
      setPositions(prev => prev.map(row => (row.id === updated.id ? updated : row)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close position')
    } finally {
      setClosingId('')
    }
  }, [sessionId])

  const visible = positions.filter(row => row.state !== 'closed' && row.state !== 'failed')

  return (
    <section className="ags-panel ags-panel--positions">
      <div className="ags-panel__head">
        <h3 className="ags-panel__title">Positions</h3>
        <span className="ags-panel__count">{visible.length}</span>
      </div>
      <div className="ags-panel__body">
        {error ? <div className="ags-error ags-error--inline">{error}</div> : null}
        {visible.length === 0 && !error ? (
          <div className="ags-empty">No open positions.</div>
        ) : (
          <table className="ags-table">
            <thead>
              <tr>
                <th>Ticker</th>
                <th>Price</th>
                <th>Buy</th>
                <th>PnL</th>
                <th>Stop</th>
                <th>State</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {visible.map(position => {
                const pnl = position.unrealized_pnl
                const cost = position.units * position.buy_price
                const pnlPct = cost > 0 ? (pnl / cost) * 100 : 0
                const flashDir = flash[position.id]
                return (
                  <tr key={position.id}>
                    <td className="ags-table__ticker">{position.ticker}</td>
                    <td
                      className={`ags-table__num${
                        flashDir ? ` ags-flash-${flashDir}` : ''
                      }`}
                    >
                      {position.current_price.toFixed(2)}
                    </td>
                    <td className="ags-table__num">{position.buy_price.toFixed(2)}</td>
                    <td className={`ags-table__num ${pnlClass(pnl)}`}>
                      {formatSignedMoney(pnl)}
                      <span className="ags-table__pct">
                        {` ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`}
                      </span>
                    </td>
                    <td className="ags-table__num">{position.stop_loss.toFixed(2)}</td>
                    <td>
                      <span className={`ags-exit-badge ags-exit-badge--${position.exit_state}`}>
                        {position.exit_state}
                      </span>
                      {position.state !== 'open' ? (
                        <span className="ags-pending-note">{position.state.replace('_', ' ')}</span>
                      ) : null}
                    </td>
                    <td>
                      {position.state === 'open' ? (
                        <button
                          type="button"
                          className="ags-close-btn"
                          disabled={closingId === position.id}
                          onClick={() => void handleClose(position)}
                        >
                          {closingId === position.id ? '…' : 'Close'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

/* ── Hunter suggestions ── */

function AgenticSuggestionsPanel({ live }: { live: boolean }) {
  const [suggestions, setSuggestions] = useState<AgenticSuggestion[]>([])
  const [error, setError] = useState('')

  const poll = useCallback(async () => {
    try {
      setSuggestions(await listAgenticSuggestions(30))
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load suggestions')
    }
  }, [])

  useEffect(() => {
    void poll()
  }, [poll])

  useEffect(() => {
    if (!live) return
    const timer = window.setInterval(() => void poll(), SUGGESTIONS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [live, poll])

  return (
    <section className="ags-panel ags-panel--suggestions">
      <div className="ags-panel__head">
        <h3 className="ags-panel__title">Hunter suggestions</h3>
        <span className="ags-panel__count">{suggestions.length}</span>
      </div>
      <div className="ags-panel__body">
        {error ? <div className="ags-error ags-error--inline">{error}</div> : null}
        {suggestions.length === 0 && !error ? (
          <div className="ags-empty">No suggestions yet.</div>
        ) : (
          <div className="ags-signal-grid">
            {suggestions.map(suggestion => (
              <article
                key={suggestion.id}
                className={`ags-signal-card${
                  suggestion.score >= 75
                    ? ' ags-signal-card--high'
                    : suggestion.score >= 50
                      ? ' ags-signal-card--medium'
                      : ''
                }`}
                title={suggestion.reason || undefined}
              >
                <div className="ags-signal-card__head">
                  <strong className="ags-signal-card__symbol">{suggestion.ticker}</strong>
                  <span className="ags-signal-card__score">{suggestion.score}</span>
                </div>
                <div className="ags-signal-card__meta">
                  <span className="ags-signal-card__price">
                    ${suggestion.price.toFixed(2)}
                  </span>
                  <span
                    className="ags-signal-card__time"
                    title={formatDbTimestamp(suggestion.generated_at)}
                  >
                    {formatRelativeTimestamp(suggestion.generated_at)}
                  </span>
                </div>
                <span className="ags-signal-card__source">{suggestion.source_screener}</span>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
