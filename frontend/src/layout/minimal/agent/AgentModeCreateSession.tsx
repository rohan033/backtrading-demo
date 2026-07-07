import { useCallback, useEffect, useState } from 'react'

import {
  defaultAccountEnv,
  pickWatchlistSymbolMatch,
  searchWatchlistSymbol,
  WATCHLIST_BROKER_OPTIONS,
  type WatchlistBroker,
  type WatchlistSymbolHit,
} from '@/lib/watchlistBrokers'
import {
  createTradingSession,
  type CreateTradingSessionInput,
  type TradingSession,
} from '@/lib/tradingSessions'

type Props = {
  open: boolean
  onClose: () => void
  onCreated: (session: TradingSession) => void
}

export default function AgentModeCreateSession({ open, onClose, onCreated }: Props) {
  const [broker, setBroker] = useState<WatchlistBroker>('etoro')
  const [accountEnv, setAccountEnv] = useState<'live' | 'demo'>('demo')
  const [maxCapital, setMaxCapital] = useState('5000')
  const [profitTarget, setProfitTarget] = useState('500')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<WatchlistSymbolHit[]>([])
  const [selected, setSelected] = useState<WatchlistSymbolHit | null>(null)
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setAccountEnv(defaultAccountEnv(broker))
  }, [broker, open])

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q || q.length < 2) {
      setSearchHits([])
      return
    }
    let cancelled = false
    setSearching(true)
    void searchWatchlistSymbol(broker, q, accountEnv).then(hits => {
      if (cancelled) return
      setSearchHits(hits as WatchlistSymbolHit[])
      setSearching(false)
    }).catch(() => {
      if (!cancelled) setSearching(false)
    })
    return () => { cancelled = true }
  }, [searchQuery, broker, accountEnv])

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    setError('')
    try {
      const input: CreateTradingSessionInput = {
        broker,
        account_env: accountEnv,
        max_capital: Number(maxCapital) || 0,
        profit_target: Number(profitTarget) || 0,
      }
      if (selected) {
        input.symbol = selected.tradingsymbol.split('-')[0]
        input.token = selected.symboltoken
        input.exchange = selected.exchange
      }
      const session: TradingSession = await createTradingSession(input)
      onCreated(session)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }, [accountEnv, broker, maxCapital, onClose, onCreated, profitTarget, selected])

  if (!open) return null

  const discoveryMode = !selected

  return (
    <div className="am-ts-create-overlay" role="dialog" aria-modal="true" aria-labelledby="am-ts-create-title">
      <div className="am-ts-create">
        <header className="am-ts-create__header">
          <div>
            <h2 id="am-ts-create-title">New trading session</h2>
            <p className="am-ts-create__subtitle">
              Set a capital goal. Pick a stock or let the agent discover one in explore.
            </p>
          </div>
          <button type="button" className="am-ts-create__close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="am-ts-create__body">
          <section className="am-ts-create__section">
            <h3 className="am-ts-create__section-title">Trading goal</h3>
            <div className="am-ts-create__grid">
              <label className="am-ts-field">
                <span>Max capital</span>
                <div className="am-ts-input-wrap">
                  <span className="am-ts-input-prefix">$</span>
                  <input
                    type="number"
                    min={0}
                    className="am-ts-input am-ts-input--prefixed"
                    value={maxCapital}
                    onChange={e => setMaxCapital(e.target.value)}
                  />
                </div>
              </label>
              <label className="am-ts-field">
                <span>Profit target</span>
                <div className="am-ts-input-wrap">
                  <span className="am-ts-input-prefix">$</span>
                  <input
                    type="number"
                    min={0}
                    className="am-ts-input am-ts-input--prefixed"
                    value={profitTarget}
                    onChange={e => setProfitTarget(e.target.value)}
                  />
                </div>
              </label>
            </div>
          </section>

          <section className="am-ts-create__section">
            <h3 className="am-ts-create__section-title">Broker &amp; account</h3>
            <div className="am-ts-create__grid">
              <label className="am-ts-field">
                <span>Broker</span>
                <select
                  className="am-ts-input am-ts-select"
                  value={broker}
                  onChange={e => setBroker(e.target.value as WatchlistBroker)}
                >
                  {WATCHLIST_BROKER_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="am-ts-field">
                <span>Account</span>
                <select
                  className="am-ts-input am-ts-select"
                  value={accountEnv}
                  onChange={e => setAccountEnv(e.target.value as 'live' | 'demo')}
                >
                  <option value="demo">Demo</option>
                  <option value="live">Live</option>
                </select>
              </label>
            </div>
            <p className="am-ts-field__hint">
              Demo is sandbox; live uses your real broker account when trading is enabled.
            </p>
          </section>

          <section className="am-ts-create__section am-ts-create__section--stock">
            <div className="am-ts-create__section-head">
              <h3 className="am-ts-create__section-title">Stock</h3>
              <span className="am-ts-create__optional">Optional</span>
            </div>
            <p className="am-ts-field__hint">
              {discoveryMode
                ? 'Leave empty — the agent will research and pick the best symbol in explore.'
                : 'Manual pick — explore will resolve this symbol and skip AI discovery.'}
            </p>

            {selected ? (
              <div className="am-ts-selected-symbol">
                <div>
                  <strong>{selected.tradingsymbol}</strong>
                  <span>{selected.exchange}</span>
                </div>
                <button type="button" className="am-ts-selected-symbol__clear" onClick={() => setSelected(null)}>
                  Clear
                </button>
              </div>
            ) : (
              <div className="am-ts-search">
                <input
                  type="search"
                  className="am-ts-input am-ts-input--search"
                  placeholder="Search ticker (e.g. NVDA, RELIANCE)…"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                />
                {searching ? <div className="am-ts-search-status">Searching…</div> : null}
                {searchHits.length > 0 ? (
                  <ul className="am-ts-search-hits">
                    {searchHits.slice(0, 8).map(hit => (
                      <li key={`${hit.symboltoken}-${hit.tradingsymbol}`}>
                        <button
                          type="button"
                          onClick={() => {
                            const picked = pickWatchlistSymbolMatch(searchHits, hit.tradingsymbol) ?? hit
                            setSelected(picked)
                            setSearchQuery('')
                            setSearchHits([])
                          }}
                        >
                          <strong>{hit.tradingsymbol}</strong>
                          <span>{hit.exchange}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {searchQuery.trim().length >= 2 && !searching && searchHits.length === 0 ? (
                  <div className="am-ts-search-status">No matches — try another ticker or leave empty for AI.</div>
                ) : null}
              </div>
            )}
          </section>

          {error ? <div className="am-ts-create__error">{error}</div> : null}
        </div>

        <footer className="am-ts-create__footer">
          <button type="button" className="am-ts-create__cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="am-ts-create__submit"
            onClick={() => { void handleSubmit() }}
            disabled={submitting}
          >
            {submitting ? 'Starting…' : discoveryMode ? 'Start · AI discovery' : 'Start session'}
          </button>
        </footer>
      </div>
    </div>
  )
}
