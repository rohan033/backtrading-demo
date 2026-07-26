import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useOverviewTradeSignals } from '@/hooks/useOverviewTradeSignals'
import {
  agenticApiUnavailable,
  agenticSessionLabel,
  createAgenticSession,
  deleteAgenticSession,
  listAgenticSessions,
  type AgenticAccountEnv,
  type AgenticSession,
} from '@/lib/agenticSessions'
import { formatDbTimestamp, formatRelativeTimestamp } from '@/lib/datetime'
import {
  formatHomeMoverAbs,
  formatHomeMoverPct,
  formatHomeMoverPrice,
  homeMoverHeroLabel,
  homeMoverMetrics,
  homeMoverPctTone,
} from '@/lib/homeMarketMovers'
import type { OverviewScreenerPick, OverviewTradeSignal } from '@/lib/overviewSignals'
import {
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  type WatchlistSymbolHit,
} from '@/lib/watchlistBrokers'
import { useUrlState } from '../useUrlState'
import '../HomeMarketMoversPanel.css'
import '../Overview.css'
import AgentModelPicker, { useAgentModelPickerState } from './dashboard/AgentModelPicker'
import { Panel } from './dashboard/shared'
import AgenticSessionWorkspace from './AgenticSessionWorkspace'
import './AgenticSessions.css'

function formatSignedMoney(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toFixed(2)}`
}

export default function AgenticSessions() {
  const { state, navigate } = useUrlState()
  const activeSessionId = state.agentic_session || ''

  const openSession = useCallback((sessionId: string) => {
    navigate({
      tab: 'agent',
      agent_panel: 'agentic',
      agentic_session: sessionId,
      trading_session: '',
      one_percent_session: '',
    })
  }, [navigate])

  const backToList = useCallback(() => {
    navigate({
      tab: 'agent',
      agent_panel: 'agentic',
      agentic_session: '',
    })
  }, [navigate])

  if (activeSessionId) {
    return (
      <AgenticSessionWorkspace
        key={activeSessionId}
        sessionId={activeSessionId}
        onBack={backToList}
      />
    )
  }

  return <AgenticSessionList onOpen={openSession} />
}

function AgenticSessionList({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [sessions, setSessions] = useState<AgenticSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [deletingId, setDeletingId] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setSessions(await listAgenticSessions())
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load sessions'
      setError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable — the backend has not started yet (make dev).'
        : message)
      setSessions([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleDelete = useCallback(async (session: AgenticSession) => {
    if (!window.confirm(`Delete ${agenticSessionLabel(session)}? This cannot be undone.`)) return
    setDeletingId(session.id)
    setError('')
    try {
      await deleteAgenticSession(session.id)
      setSessions(prev => prev.filter(row => row.id !== session.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    } finally {
      setDeletingId('')
    }
  }, [])

  return (
    <div className="ags-root">
      <div className={`ags-list-panel${createOpen ? ' ags-list-panel--create' : ''}`}>
        <div className={`ags-list-head${createOpen ? ' ags-list-head--create' : ''}`}>
          {!createOpen ? <h2 className="ags-list-title">Agentic sessions</h2> : null}
          <div className="ags-list-head__actions">
            {createOpen ? (
              <>
                <button
                  type="button"
                  className="ags-btn ags-btn--mini"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="ags-btn ags-btn--mini ags-btn--mini-primary"
                  onClick={() => setCreateOpen(false)}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="ags-btn"
                  onClick={() => void refresh()}
                  disabled={loading}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="ags-btn ags-btn--primary"
                  onClick={() => setCreateOpen(true)}
                >
                  New session
                </button>
              </>
            )}
          </div>
        </div>

        {error ? <div className="ags-error">{error}</div> : null}

        {createOpen ? (
          <div className="ags-create-shell ags-wire">
            <AgenticCreateForm
              onCreated={session => {
                setCreateOpen(false)
                onOpen(session.id)
              }}
            />
          </div>
        ) : null}

        {!createOpen && loading ? (
          <div className="ags-empty">Loading sessions…</div>
        ) : !createOpen && sessions.length === 0 && !error ? (
          <div className="ags-empty">
            No agentic sessions yet. Create one to let the agent hunt and trade for you.
          </div>
        ) : !createOpen ? (
          <ul className="ags-session-list">
            {sessions.map(session => (
              <li key={session.id}>
                <div
                  className="ags-session-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpen(session.id)}
                  onKeyDown={event => {
                    if (event.key === 'Enter' || event.key === ' ') onOpen(session.id)
                  }}
                >
                  <span className={`ags-status-pill ags-status-pill--${session.status}`}>
                    {session.status}
                  </span>
                  <span className="ags-session-row__name">{agenticSessionLabel(session)}</span>
                  <span className={`ags-env-badge ags-env-badge--${session.account_env}`}>
                    {session.account_env}
                  </span>
                  <span
                    className="ags-session-row__started"
                    title={formatDbTimestamp(session.started_at || session.created_at)}
                  >
                    {formatRelativeTimestamp(session.started_at || session.created_at)}
                  </span>
                  <span
                    className={`ags-session-row__pnl ${
                      session.stats.realized_pnl > 0
                        ? 'ags-pos'
                        : session.stats.realized_pnl < 0
                          ? 'ags-neg'
                          : ''
                    }`}
                  >
                    {formatSignedMoney(session.stats.realized_pnl)}
                  </span>
                  {session.status === 'stopped' ? (
                    <button
                      type="button"
                      className="ags-session-row__delete"
                      title="Delete session"
                      disabled={deletingId === session.id}
                      onClick={event => {
                        event.stopPropagation()
                        void handleDelete(session)
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  )
}

function AgenticCreateForm({ onCreated }: { onCreated: (session: AgenticSession) => void }) {
  const [name, setName] = useState('')
  const [accountEnv, setAccountEnv] = useState<AgenticAccountEnv>('demo')
  const [startBalance, setStartBalance] = useState('')
  const [confidenceThreshold, setConfidenceThreshold] = useState('40')
  const [prompt, setPrompt] = useState('')
  const [selectedTickers, setSelectedTickers] = useState<string[]>([])
  const [tickerQuery, setTickerQuery] = useState('')
  const [tickerHits, setTickerHits] = useState<WatchlistSymbolHit[]>([])
  const [tickerSearching, setTickerSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const modelPicker = useAgentModelPickerState()

  const {
    signals: suggestedSignals,
    screenerPicks,
    loading: suggestionsLoading,
    error: suggestionsError,
  } = useOverviewTradeSignals({ enabled: true, accountEnv })

  const pickBySymbol = useMemo(() => {
    const map = new Map<string, OverviewScreenerPick>()
    for (const pick of screenerPicks) map.set(pick.symbol, pick)
    return map
  }, [screenerPicks])

  useEffect(() => {
    const q = tickerQuery.trim()
    if (q.length < 2) {
      setTickerHits([])
      return undefined
    }
    let cancelled = false
    setTickerSearching(true)
    void searchWatchlistSymbol('etoro', q, accountEnv)
      .then(hits => {
        if (!cancelled) setTickerHits(hits)
      })
      .catch(() => {
        if (!cancelled) setTickerHits([])
      })
      .finally(() => {
        if (!cancelled) setTickerSearching(false)
      })
    return () => { cancelled = true }
  }, [tickerQuery, accountEnv])

  const addTicker = useCallback((raw: string) => {
    const symbol = raw.trim().toUpperCase()
    if (!symbol) return
    setSelectedTickers(prev => (prev.includes(symbol) ? prev : [...prev, symbol]))
    setTickerQuery('')
    setTickerHits([])
  }, [])

  const addTickerFromHit = useCallback((hit: WatchlistSymbolHit) => {
    const match = pickWatchlistSymbolMatch([hit], tickerQuery.trim() || hit.tradingsymbol)
    const root = (match?.tradingsymbol || hit.tradingsymbol).split('-')[0].toUpperCase()
    addTicker(root)
  }, [addTicker, tickerQuery])

  const toggleTicker = useCallback((symbol: string) => {
    const normalized = symbol.trim().toUpperCase()
    if (!normalized) return
    setSelectedTickers(prev =>
      prev.includes(normalized)
        ? prev.filter(row => row !== normalized)
        : [...prev, normalized],
    )
  }, [])

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    setError('')
    const balance = startBalance.trim() === '' ? undefined : Number(startBalance)
    if (balance != null && (!Number.isFinite(balance) || balance <= 0)) {
      setError('Start balance must be a positive number.')
      setSubmitting(false)
      return
    }
    const confidence = Number(confidenceThreshold)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
      setError('Confidence threshold must be between 0 and 100.')
      setSubmitting(false)
      return
    }
    const config: Record<string, unknown> = {
      confidence_threshold: confidence,
    }
    if (selectedTickers.length) config.tickers = selectedTickers
    try {
      const session = await createAgenticSession({
        name: name.trim() || undefined,
        prompt: prompt.trim() || undefined,
        account_env: accountEnv,
        start_balance: balance,
        config: config,
        agent_model: modelPicker.agentModelId || null,
        agent_model_params: modelPicker.agentModelParams.filter(row => row.id && row.value),
      })
      onCreated(session)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session'
      setError(agenticApiUnavailable(message)
        ? 'Agentic trading API is unavailable — the backend has not started yet (make dev).'
        : message)
      setSubmitting(false)
    }
  }, [
    accountEnv,
    name,
    onCreated,
    prompt,
    selectedTickers,
    startBalance,
    confidenceThreshold,
    modelPicker.agentModelId,
    modelPicker.agentModelParams,
  ])

  return (
    <form
      className="ags-create-wire"
      onSubmit={event => {
        event.preventDefault()
        void handleSubmit()
      }}
    >
      <div className="ags-wire-grid ags-create-wire__grid">
        <div className="ags-wire-col ags-wire-col--left">
          <Panel title="Model" bodyClassName="ags-create-wire__panel-body">
            <div className="ags-create-wire__model">
              <AgentModelPicker
                value={modelPicker.value}
                onChange={modelPicker.setValue}
                layout="stack"
                dense
              />
            </div>
            <label className="ags-create-wire__field">
              <span className="ags-field__label">Input prompt</span>
              <textarea
                className="ags-input ags-textarea ags-create-wire__prompt"
                value={prompt}
                onChange={event => setPrompt(event.target.value)}
                placeholder="Tickers to avoid, sectors to favor, risk appetite…"
                rows={4}
              />
            </label>
          </Panel>

          <Panel title="Session" bodyClassName="ags-create-wire__panel-body">
            <div className="ags-create-wire__row">
              <label className="ags-create-wire__field ags-create-wire__field--grow">
                <span className="ags-field__label">Name (optional)</span>
                <input
                  className="ags-input"
                  type="text"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder="Morning momentum run"
                />
              </label>
              <div className="ags-create-wire__field">
                <span className="ags-field__label">Demo / Live</span>
                <div className="ags-create-wire__env">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={accountEnv === 'live'}
                    className={`ags-create-wire__toggle${accountEnv === 'live' ? ' ags-create-wire__toggle--live' : ''}`}
                    onClick={() => setAccountEnv(prev => (prev === 'demo' ? 'live' : 'demo'))}
                  >
                    <span className="ags-create-wire__toggle-knob" aria-hidden />
                    <span className="ags-create-wire__toggle-label">
                      {accountEnv === 'live' ? 'Live' : 'Demo'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
            <div className="ags-create-wire__row">
              <label className="ags-create-wire__field">
                <span className="ags-field__label">Capital</span>
                <input
                  className="ags-input"
                  type="number"
                  min="0"
                  step="any"
                  value={startBalance}
                  onChange={event => setStartBalance(event.target.value)}
                  placeholder="1000"
                />
              </label>
              <label
                className="ags-create-wire__field"
                title="Screener picks need score ≥ this. Watchlist enters at 40+."
              >
                <span className="ags-field__label">Confidence score</span>
                <input
                  className="ags-input"
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={confidenceThreshold}
                  onChange={event => setConfidenceThreshold(event.target.value)}
                  placeholder="40"
                />
              </label>
            </div>
          </Panel>
        </div>

        <div className="ags-wire-col ags-wire-col--mid">
          <Panel
            title="Suggested"
            count={suggestedSignals.length || undefined}
            className="ags-col-fill"
            bodyClassName="ags-create-wire__screeners"
          >
            {suggestionsLoading && suggestedSignals.length === 0 ? (
              <div className="ags-wire-empty">Loading suggestions…</div>
            ) : suggestionsError && suggestedSignals.length === 0 ? (
              <div className="ags-wire-empty">{suggestionsError}</div>
            ) : suggestedSignals.length === 0 ? (
              <div className="ags-wire-empty">
                No suggestions right now — screeners may have no qualifying movers.
              </div>
            ) : (
              <div className="ov-screener__grid ags-create-wire__suggest-grid">
                {suggestedSignals.map(signal => (
                  <AgenticCreateSuggestionCard
                    key={signal.symbol}
                    signal={signal}
                    pick={pickBySymbol.get(signal.symbol)}
                    selected={selectedTickers.includes(signal.symbol)}
                    onToggle={() => toggleTicker(signal.symbol)}
                  />
                ))}
              </div>
            )}
          </Panel>

          <label className="ags-create-wire__field">
            <span className="ags-field__label">Additional stocks</span>
            <AgenticTickerMultiselect
              accountEnv={accountEnv}
              selected={selectedTickers}
              query={tickerQuery}
              hits={tickerHits}
              searching={tickerSearching}
              onQueryChange={setTickerQuery}
              onAddTicker={addTicker}
              onAddHit={addTickerFromHit}
              onRemove={symbol => setSelectedTickers(prev => prev.filter(row => row !== symbol))}
              onClear={() => setSelectedTickers([])}
              compact
            />
          </label>

          <div className="ags-create-wire__field">
            <span className="ags-field__label">Additional watchlists</span>
            <div className="ags-create-wire__watchbox">
              {selectedTickers.length ? (
                <div className="ags-ms__chips ags-create-wire__watch-chips">
                  {selectedTickers.map(symbol => (
                    <button
                      key={symbol}
                      type="button"
                      className="ags-ms__chip"
                      onClick={() => toggleTicker(symbol)}
                      aria-label={`Remove ${symbol}`}
                    >
                      <strong>{symbol}</strong>
                      <span aria-hidden="true">×</span>
                    </button>
                  ))}
                </div>
              ) : (
                <span className="ags-create-wire__watch-empty">
                  Click suggested tickers or search above to add watchlist names.
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="ags-wire-col ags-wire-col--right">
          <Panel title="Review" className="ags-col-fill" bodyClassName="ags-create-wire__review">
            <section className="ags-create-wire__review-block">
              <h3 className="ags-create-wire__review-label">Prompt</h3>
              <p className="ags-create-wire__review-text">
                {prompt.trim() || 'No instructions yet.'}
              </p>
            </section>
            <section className="ags-create-wire__review-block">
              <h3 className="ags-create-wire__review-label">Selected stocks / ticker names</h3>
              {selectedTickers.length ? (
                <ul className="ags-create-wire__review-tickers">
                  {selectedTickers.map(symbol => (
                    <li key={symbol}>{symbol}</li>
                  ))}
                </ul>
              ) : (
                <p className="ags-create-wire__review-muted">None selected</p>
              )}
            </section>
            <section className="ags-create-wire__review-block">
              <h3 className="ags-create-wire__review-label">Session info</h3>
              <dl className="ags-create-wire__review-dl">
                <div><dt>Name</dt><dd>{name.trim() || 'Untitled'}</dd></div>
                <div><dt>Account</dt><dd>{accountEnv}</dd></div>
                <div><dt>Capital</dt><dd>{startBalance.trim() || 'Default'}</dd></div>
                <div><dt>Confidence</dt><dd>{confidenceThreshold || '40'}</dd></div>
                <div><dt>Model</dt><dd>{modelPicker.agentModelId || 'SDK default'}</dd></div>
                <div>
                  <dt>Universe</dt>
                  <dd>
                    {selectedTickers.length
                      ? `Watchlist only (${selectedTickers.length})`
                      : 'All screeners'}
                  </dd>
                </div>
              </dl>
            </section>
          </Panel>

          {error ? <div className="ags-error ags-error--inline">{error}</div> : null}
          <button
            type="submit"
            className="ags-wire-btn ags-wire-btn--create"
            disabled={submitting}
          >
            {submitting ? 'Starting…' : 'Create'}
          </button>
        </div>
      </div>
    </form>
  )
}

function AgenticCreateSuggestionCard({
  signal,
  pick,
  selected,
  onToggle,
}: {
  signal: OverviewTradeSignal
  pick?: OverviewScreenerPick
  selected: boolean
  onToggle: () => void
}) {
  const metrics = pick
    ? homeMoverMetrics(pick.row, pick.sourceType)
    : {
        pct: signal.changePct,
        price: null,
        changeAbs: null,
      }
  const tone = homeMoverPctTone(metrics.pct)
  const heroLabel = pick
    ? homeMoverHeroLabel(pick.row, pick.sourceType)
    : 'Chg %'
  const tooltip = [signal.reasons.join(' · '), pick?.screenerName ? `Score ${signal.score}` : '']
    .filter(Boolean)
    .join('\n')

  return (
    <button
      type="button"
      className={`hm-mover-card ov-mover-card ags-create-pick-card${selected ? ' ags-create-pick-card--selected' : ''}`}
      aria-pressed={selected}
      title={tooltip || undefined}
      onClick={onToggle}
    >
      <header className="hm-mover-card__head">
        <span className="hm-mover-card__symbol">{signal.symbol}</span>
        <span className="ags-create-pick-card__score">{signal.score}</span>
      </header>
      <div className="hm-mover-card__body">
        <div className="ov-mover-card__hero">
          <div className={`hm-mover-card__pct hm-mover-card__pct--${tone}`}>
            {formatHomeMoverPct(metrics.pct ?? signal.changePct)}
          </div>
          <span className="ov-mover-card__hero-label">{heroLabel}</span>
        </div>
        {metrics.price != null ? (
          <div className="hm-mover-card__meta">
            <span className="hm-mover-card__price ov-mover-card__price">
              {formatHomeMoverPrice(metrics.price)}
            </span>
            <span className={`hm-mover-card__abs hm-mover-card__abs--${tone}`}>
              {formatHomeMoverAbs(metrics.changeAbs)}
            </span>
          </div>
        ) : null}
      </div>
    </button>
  )
}

function AgenticTickerMultiselect({
  accountEnv,
  selected,
  query,
  hits,
  searching,
  onQueryChange,
  onAddTicker,
  onAddHit,
  onRemove,
  onClear,
  compact = false,
}: {
  accountEnv: AgenticAccountEnv
  selected: string[]
  query: string
  hits: WatchlistSymbolHit[]
  searching: boolean
  onQueryChange: (value: string) => void
  onAddTicker: (symbol: string) => void
  onAddHit: (hit: WatchlistSymbolHit) => void
  onRemove: (symbol: string) => void
  onClear: () => void
  compact?: boolean
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const showHits = open && query.trim().length >= 2

  return (
    <div className="ags-ms" ref={rootRef}>
      {!compact && selected.length ? (
        <div className="ags-ms__chips">
          {selected.map(symbol => (
            <button
              key={symbol}
              type="button"
              className="ags-ms__chip"
              onClick={() => onRemove(symbol)}
              aria-label={`Remove ${symbol}`}
            >
              <strong>{symbol}</strong>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          <button type="button" className="ags-ms__clear" onClick={onClear}>
            Clear
          </button>
        </div>
      ) : null}
      <div className="ags-ms__search-row">
        <input
          className="ags-input"
          type="search"
          value={query}
          placeholder={`Search eToro ${accountEnv} — BTC, AAPL…`}
          onFocus={() => setOpen(true)}
          onChange={event => {
            onQueryChange(event.target.value)
            setOpen(true)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              onAddTicker(query)
            }
          }}
        />
        <button
          type="button"
          className="ags-btn"
          disabled={!query.trim()}
          onClick={() => onAddTicker(query)}
        >
          Add
        </button>
      </div>
      {showHits ? (
        <ul className="ags-ms__hits">
          {searching ? (
            <li className="ags-ms-empty">Searching…</li>
          ) : hits.length === 0 ? (
            <li className="ags-ms-empty">No matches — press Add to use “{query.trim().toUpperCase()}”</li>
          ) : (
            hits.slice(0, 8).map(hit => {
              const root = hit.tradingsymbol.split('-')[0].toUpperCase()
              return (
                <li key={`${hit.symboltoken}:${hit.tradingsymbol}`}>
                  <button type="button" className="ags-ms__hit" onClick={() => onAddHit(hit)}>
                    <strong>{root}</strong>
                    <span>{hit.name || hit.tradingsymbol}</span>
                  </button>
                </li>
              )
            })
          )}
        </ul>
      ) : null}
    </div>
  )
}
