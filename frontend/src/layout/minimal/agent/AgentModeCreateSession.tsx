import { useCallback, useEffect, useMemo, useState } from 'react'

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
import {
  defaultParamsForModel,
  listCursorAgentModels,
  paramValueFor,
  setParamValue,
  type AgentModelParamSelection,
  type CursorAgentModel,
} from '@/lib/cursorAgentModels'

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
  const [prompt, setPrompt] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchHits, setSearchHits] = useState<WatchlistSymbolHit[]>([])
  const [selected, setSelected] = useState<WatchlistSymbolHit | null>(null)
  const [searching, setSearching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<CursorAgentModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [agentModelId, setAgentModelId] = useState('')
  const [agentModelParams, setAgentModelParams] = useState<AgentModelParamSelection[]>([])

  const selectedModel = useMemo(
    () => models.find(m => m.id === agentModelId) || null,
    [models, agentModelId],
  )

  useEffect(() => {
    if (!open) return
    setAccountEnv(defaultAccountEnv(broker))
  }, [broker, open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setModelsLoading(true)
    setModelsError('')
    void listCursorAgentModels()
      .then(rows => {
        if (cancelled) return
        setModels(rows)
        setModelsLoading(false)
        if (!rows.length) return
        const preferred =
          rows.find(m => m.id === 'composer-2.5') ||
          rows.find(m => m.variants?.some(v => v.is_default)) ||
          rows[0]
        setAgentModelId(prev => {
          if (prev && rows.some(m => m.id === prev)) return prev
          return preferred.id
        })
        setAgentModelParams(prev => {
          // Keep existing params when reopening with same selection already set.
          if (prev.length) return prev
          return defaultParamsForModel(preferred)
        })
      })
      .catch(err => {
        if (cancelled) return
        setModels([])
        setModelsLoading(false)
        setModelsError(err instanceof Error ? err.message : 'Failed to load models')
      })
    return () => { cancelled = true }
  }, [open])

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

  const handleModelChange = useCallback((modelId: string) => {
    setAgentModelId(modelId)
    const model = models.find(m => m.id === modelId) || null
    setAgentModelParams(defaultParamsForModel(model))
  }, [models])

  const handleVariantSelect = useCallback((variantDisplayName: string) => {
    if (!selectedModel) return
    const variant = selectedModel.variants?.find(v => v.display_name === variantDisplayName)
    if (!variant) return
    setAgentModelParams(
      (variant.params || [])
        .filter(p => p.id && p.value)
        .map(p => ({ id: String(p.id), value: String(p.value) })),
    )
  }, [selectedModel])

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
      const trimmedPrompt = prompt.trim()
      if (trimmedPrompt) input.prompt = trimmedPrompt
      if (selected) {
        input.symbol = selected.tradingsymbol.split('-')[0]
        input.token = selected.symboltoken
        input.exchange = selected.exchange
      }
      if (agentModelId) {
        input.agent_model = agentModelId
        input.agent_model_params = agentModelParams.filter(p => p.id && p.value)
      }
      const session: TradingSession = await createTradingSession(input)
      onCreated(session)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }, [
    accountEnv,
    agentModelId,
    agentModelParams,
    broker,
    maxCapital,
    onClose,
    onCreated,
    profitTarget,
    prompt,
    selected,
  ])

  if (!open) return null

  const discoveryMode = !selected
  const activeVariantName =
    selectedModel?.variants?.find(v => {
      const vp = (v.params || []).map(p => `${p.id}=${p.value}`).sort().join('|')
      const cur = [...agentModelParams].map(p => `${p.id}=${p.value}`).sort().join('|')
      return vp === cur
    })?.display_name || ''

  return (
    <div
      className="am-ts-create-overlay am-ts-create-overlay--drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="am-ts-create-title"
      onClick={onClose}
    >
      <aside className="am-ts-create am-ts-create--drawer" onClick={e => e.stopPropagation()}>
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

          <section className="am-ts-create__section">
            <h3 className="am-ts-create__section-title">Cursor model</h3>
            <p className="am-ts-field__hint">
              Model and params used for agent runs in this session.
            </p>
            {modelsLoading ? (
              <div className="am-ts-search-status">Loading models…</div>
            ) : modelsError ? (
              <div className="am-ts-create__error">{modelsError}</div>
            ) : (
              <>
                <label className="am-ts-field">
                  <span>Model</span>
                  <select
                    className="am-ts-input am-ts-select"
                    value={agentModelId}
                    onChange={e => handleModelChange(e.target.value)}
                    disabled={!models.length}
                  >
                    {!models.length ? <option value="">No models available</option> : null}
                    {models.map(m => (
                      <option key={m.id} value={m.id}>
                        {m.display_name || m.id}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedModel?.description ? (
                  <p className="am-ts-field__hint am-ts-model-desc">{selectedModel.description}</p>
                ) : null}

                {selectedModel?.variants?.length ? (
                  <label className="am-ts-field">
                    <span>Preset</span>
                    <select
                      className="am-ts-input am-ts-select"
                      value={activeVariantName}
                      onChange={e => handleVariantSelect(e.target.value)}
                    >
                      <option value="">Custom</option>
                      {selectedModel.variants.map(v => (
                        <option key={v.display_name} value={v.display_name}>
                          {v.display_name}{v.is_default ? ' (default)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {selectedModel?.parameters?.length ? (
                  <div className="am-ts-model-params">
                    {selectedModel.parameters.map(param => (
                      <label key={param.id} className="am-ts-field">
                        <span>{param.display_name || param.id}</span>
                        <select
                          className="am-ts-input am-ts-select"
                          value={paramValueFor(agentModelParams, param.id)}
                          onChange={e => {
                            setAgentModelParams(setParamValue(agentModelParams, param.id, e.target.value))
                          }}
                        >
                          <option value="">—</option>
                          {(param.values || []).map(v => (
                            <option key={v.value} value={v.value}>
                              {v.display_name || v.value}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                ) : null}
              </>
            )}
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

          <section className="am-ts-create__section">
            <div className="am-ts-create__section-head">
              <h3 className="am-ts-create__section-title">Prompt</h3>
              <span className="am-ts-create__optional">Optional</span>
            </div>
            <p className="am-ts-field__hint">
              {discoveryMode
                ? 'Steer AI discovery — e.g. "focus on AI semiconductor names with upcoming earnings".'
                : 'Extra instructions for the agent while it works this symbol.'}
            </p>
            <textarea
              className="am-ts-input am-ts-textarea"
              rows={3}
              placeholder="Add an instruction for the agent…"
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
            />
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
      </aside>
    </div>
  )
}
