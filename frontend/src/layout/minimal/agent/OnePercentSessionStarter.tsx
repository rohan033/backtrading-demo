import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  createOnePercentSession,
  fetchOnePercentEligibility,
  fetchOnePercentPresets,
  isTerminalOnePercentState,
  type CreateOnePercentSessionInput,
  type OnePercentEligibility,
  type OnePercentPreset,
  type OnePercentScreenerMode,
  type OnePercentSelectionMode,
  type OnePercentSession,
  type OnePercentSessionConfig,
  type OnePercentSessionDetail,
} from '@/lib/onePercentSessions'
import {
  defaultParamsForModel,
  listCursorAgentModels,
  paramValueFor,
  setParamValue,
  type AgentModelParamSelection,
  type CursorAgentModel,
} from '@/lib/cursorAgentModels'
import { fetchScreeners, type Screener } from '@/lib/screenerApi'
import { fetchWatchlists, type Watchlist } from '@/lib/watchlists'
import { buildShellUrl } from '../useUrlState'

type Props = {
  onCreated: (session: OnePercentSessionDetail) => void
  /** When true, inputs are read-only (session already running). */
  frozen?: boolean
  /** Config shown while frozen (from the active session). */
  frozenConfig?: OnePercentSessionConfig | null
  frozenAccountEnv?: string | null
  /** Compact side-panel layout (no hero CTA expand/collapse). */
  embedded?: boolean
  /** Active non-terminal session freezes the form. */
  runningSession?: OnePercentSession | null
}

const DEFAULTS = {
  capital: '1000',
  targetPct: '1',
  takeProfitPct: '1.5',
  stopLossPct: '2',
  maxAttempts: '3',
  minScore: '0',
}

const FOCUS_SYMBOL_LIMIT = 8

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}

function parseFocusSymbols(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.replace(/;/g, ',').split(/[,\s]+/)) {
    const sym = part.trim().toUpperCase().split('.', 1)[0]
    if (sym && !out.includes(sym)) out.push(sym)
    if (out.length >= FOCUS_SYMBOL_LIMIT) break
  }
  return out
}

function watchlistTickerRoot(symbol: { tradingsymbol?: string; symbol?: string }): string {
  const raw = String(symbol.tradingsymbol || symbol.symbol || '').trim().toUpperCase()
  return raw.split('.', 1)[0]
}

function mergeFocusSymbols(...groups: string[][]): string[] {
  const out: string[] = []
  for (const group of groups) {
    for (const raw of group) {
      const sym = String(raw || '').trim().toUpperCase().split('.', 1)[0]
      if (!sym || out.includes(sym)) continue
      out.push(sym)
      if (out.length >= FOCUS_SYMBOL_LIMIT) return out
    }
  }
  return out
}

type WatchlistOption = {
  root: string
  label: string
  watchlistId: string
  watchlistName: string
}

function WatchlistSymbolMultiselect({
  options,
  selected,
  disabled = false,
  loading = false,
  emptyHref,
  accountEnv,
  slotsLeft,
  onToggle,
  onToggleWatchlist,
  onClear,
}: {
  options: WatchlistOption[]
  selected: string[]
  disabled?: boolean
  loading?: boolean
  emptyHref: string
  accountEnv: string
  slotsLeft: number
  onToggle: (ticker: string) => void
  onToggleWatchlist: (watchlistId: string, roots: string[]) => void
  onClear: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return undefined
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => searchRef.current?.focus(), 0)
    return () => window.clearTimeout(timer)
  }, [open])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return options
    return options.filter(option => {
      const hay = `${option.root} ${option.label} ${option.watchlistName}`.toLowerCase()
      return hay.includes(needle)
    })
  }, [options, query])

  const grouped = useMemo(() => {
    const byList = new Map<string, { name: string; items: WatchlistOption[] }>()
    for (const option of filtered) {
      const bucket = byList.get(option.watchlistId) || {
        name: option.watchlistName,
        items: [],
      }
      bucket.items.push(option)
      byList.set(option.watchlistId, bucket)
    }
    return [...byList.entries()]
  }, [filtered])

  const triggerLabel = selected.length
    ? `${selected.length} selected`
    : loading
      ? 'Loading watchlists…'
      : options.length
        ? 'Select watchlist symbols'
        : `No eToro ${accountEnv} symbols`

  return (
    <div className="opc-ms" ref={rootRef}>
      <button
        type="button"
        className={`opc-ms__trigger${open ? ' opc-ms__trigger--open' : ''}`}
        disabled={disabled || loading || (!options.length && !selected.length)}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(prev => !prev)}
      >
        <span className="opc-ms__trigger-label">{triggerLabel}</span>
        <span className="opc-ms__chevron" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {selected.length ? (
        <div className="opc-ms__chips">
          {selected.map(symbol => (
            <button
              key={symbol}
              type="button"
              className="opc-ms__chip"
              disabled={disabled}
              onClick={() => onToggle(symbol)}
              aria-label={`Remove ${symbol}`}
            >
              <strong>{symbol}</strong>
              <span aria-hidden="true">×</span>
            </button>
          ))}
          {!disabled ? (
            <button type="button" className="opc-ms__clear" onClick={onClear}>
              Clear
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="opc-ms__menu" role="listbox" aria-multiselectable="true">
          <div className="opc-ms__search">
            <input
              ref={searchRef}
              type="search"
              value={query}
              disabled={disabled}
              placeholder="Search ticker or watchlist…"
              onChange={event => setQuery(event.target.value)}
            />
          </div>
          {!options.length ? (
            <p className="opc-ms__empty">
              No eToro {accountEnv} watchlists yet.{' '}
              <a href={emptyHref}>Add symbols in Watch &amp; Trade</a>.
            </p>
          ) : !grouped.length ? (
            <p className="opc-ms__empty">No symbols match “{query.trim()}”.</p>
          ) : (
            <div className="opc-ms__groups">
              {grouped.map(([watchlistId, group]) => {
                const roots = group.items.map(item => item.root)
                const selectedCount = roots.filter(root => selected.includes(root)).length
                const allSelected = roots.length > 0 && selectedCount === roots.length
                const someSelected = selectedCount > 0 && !allSelected
                return (
                  <section key={watchlistId} className="opc-ms__group">
                    <label className="opc-ms__group-head">
                      <span className="opc-ms__group-title">
                        <input
                          type="checkbox"
                          disabled={disabled || (!allSelected && slotsLeft <= 0 && !someSelected)}
                          checked={allSelected}
                          ref={el => {
                            if (el) el.indeterminate = someSelected
                          }}
                          onChange={() => onToggleWatchlist(watchlistId, roots)}
                        />
                        <strong>{group.name}</strong>
                      </span>
                      <span>
                        {selectedCount}/{group.items.length}
                      </span>
                    </label>
                    <ul className="opc-ms__options">
                      {group.items.map(option => {
                        const checked = selected.includes(option.root)
                        const atCap = !checked && slotsLeft <= 0
                        return (
                          <li key={`${watchlistId}:${option.root}`}>
                            <label className={`opc-ms__option${atCap ? ' opc-ms__option--disabled' : ''}`}>
                              <input
                                type="checkbox"
                                disabled={disabled || atCap}
                                checked={checked}
                                onChange={() => onToggle(option.root)}
                              />
                              <span>
                                <em>{option.root}</em>
                                {option.label !== option.root ? <small>{option.label}</small> : null}
                              </span>
                            </label>
                          </li>
                        )
                      })}
                    </ul>
                  </section>
                )
              })}
            </div>
          )}
          {slotsLeft === 0 ? (
            <p className="opc-ms__cap">Selection limit reached ({FOCUS_SYMBOL_LIMIT}).</p>
          ) : (
            <p className="opc-ms__cap">{slotsLeft} slot{slotsLeft === 1 ? '' : 's'} left</p>
          )}
        </div>
      ) : null}
    </div>
  )
}

export default function OnePercentSessionStarter({
  onCreated,
  frozen = false,
  frozenConfig = null,
  frozenAccountEnv = null,
  embedded = false,
  runningSession = null,
}: Props) {
  const isFrozen = frozen || Boolean(runningSession && !isTerminalOnePercentState(runningSession.state))
  const [accountEnv, setAccountEnv] = useState<'demo' | 'live'>('demo')
  const [capital, setCapital] = useState(DEFAULTS.capital)
  const [targetPct, setTargetPct] = useState(DEFAULTS.targetPct)
  const [takeProfitPct, setTakeProfitPct] = useState(DEFAULTS.takeProfitPct)
  const [stopLossPct, setStopLossPct] = useState(DEFAULTS.stopLossPct)
  const [maxAttempts, setMaxAttempts] = useState(DEFAULTS.maxAttempts)
  const [minScore, setMinScore] = useState(DEFAULTS.minScore)
  const [selectionMode, setSelectionMode] = useState<OnePercentSelectionMode>('deterministic')
  const [focusSymbolsText, setFocusSymbolsText] = useState('')
  const [watchlistSymbols, setWatchlistSymbols] = useState<string[]>([])
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [watchlistsLoading, setWatchlistsLoading] = useState(false)
  const [screenerMode, setScreenerMode] = useState<OnePercentScreenerMode>('auto')
  const [queryKeys, setQueryKeys] = useState<string[]>([])
  const [screenerIds, setScreenerIds] = useState<string[]>([])
  const [presets, setPresets] = useState<OnePercentPreset[]>([])
  const [savedScreeners, setSavedScreeners] = useState<Screener[]>([])
  const [eligibility, setEligibility] = useState<OnePercentEligibility | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [models, setModels] = useState<CursorAgentModel[]>([])
  const [modelsLoading, setModelsLoading] = useState(false)
  const [modelsError, setModelsError] = useState('')
  const [agentModelId, setAgentModelId] = useState('')
  const [agentModelParams, setAgentModelParams] = useState<AgentModelParamSelection[]>([])

  const typedFocusSymbols = useMemo(() => parseFocusSymbols(focusSymbolsText), [focusSymbolsText])
  const focusSymbols = useMemo(
    () => mergeFocusSymbols(watchlistSymbols, typedFocusSymbols),
    [typedFocusSymbols, watchlistSymbols],
  )
  const usingFocusSymbols = focusSymbols.length > 0
  const showScreenerControls = !usingFocusSymbols
  const showAgentModel = selectionMode === 'agent'
  const focusSlotsLeft = Math.max(0, FOCUS_SYMBOL_LIMIT - focusSymbols.length)

  const etoroWatchlists = useMemo(
    () =>
      watchlists.filter(
        list =>
          list.broker === 'etoro'
          && (list.account_env || 'demo').toLowerCase() === accountEnv,
      ),
    [accountEnv, watchlists],
  )

  const watchlistOptions = useMemo(() => {
    const options: WatchlistOption[] = []
    const seen = new Set<string>()
    for (const list of etoroWatchlists) {
      for (const symbol of list.symbols || []) {
        const root = watchlistTickerRoot(symbol)
        if (!root) continue
        const key = `${list.id}:${root}`
        if (seen.has(key)) continue
        seen.add(key)
        options.push({
          root,
          label: symbol.tradingsymbol || symbol.symbol || root,
          watchlistId: list.id,
          watchlistName: list.name || 'Watchlist',
        })
      }
    }
    return options
  }, [etoroWatchlists])

  const selectedModel = useMemo(
    () => models.find(m => m.id === agentModelId) || null,
    [models, agentModelId],
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [presetRows, screenerRows] = await Promise.all([
          fetchOnePercentPresets(),
          fetchScreeners(false),
        ])
        if (cancelled) return
        setPresets(presetRows)
        setSavedScreeners(screenerRows)
      } catch {
        if (!cancelled) {
          setPresets([])
          setSavedScreeners([])
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setWatchlistsLoading(true)
    void fetchWatchlists()
      .then(rows => {
        if (cancelled) return
        setWatchlists(rows)
        setWatchlistsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setWatchlists([])
        setWatchlistsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    // Drop selections that are no longer on the active account's eToro watchlists.
    const allowed = new Set<string>()
    for (const list of etoroWatchlists) {
      for (const symbol of list.symbols || []) {
        const root = watchlistTickerRoot(symbol)
        if (root) allowed.add(root)
      }
    }
    setWatchlistSymbols(prev => {
      const next = prev.filter(sym => allowed.has(sym))
      if (next.length === prev.length && next.every((sym, index) => sym === prev[index])) {
        return prev
      }
      return next
    })
  }, [etoroWatchlists])

  useEffect(() => {
    if (!showAgentModel || isFrozen) return
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
        setAgentModelParams(prev => (prev.length ? prev : defaultParamsForModel(preferred)))
      })
      .catch(err => {
        if (cancelled) return
        setModels([])
        setModelsLoading(false)
        setModelsError(err instanceof Error ? err.message : 'Failed to load models')
      })
    return () => {
      cancelled = true
    }
  }, [isFrozen, showAgentModel])

  useEffect(() => {
    if (!isFrozen) return
    const cfg = frozenConfig || runningSession?.config
    const env = (frozenAccountEnv || runningSession?.account_env || 'demo') as 'demo' | 'live'
    if (!cfg) return
    setAccountEnv(env === 'live' ? 'live' : 'demo')
    setCapital(String(cfg.capital ?? 1000))
    setTargetPct(String(cfg.target_pct ?? 1))
    setTakeProfitPct(String(cfg.take_profit_pct ?? 1.5))
    setStopLossPct(String(cfg.stop_loss_pct ?? 2))
    setMaxAttempts(String(cfg.max_attempts ?? 3))
    setMinScore(String(cfg.min_score ?? 0))
    setSelectionMode(cfg.selection_mode === 'agent' || cfg.selection_mode === 'hybrid' ? 'agent' : 'deterministic')
    const frozenFocus = Array.isArray(cfg.focus_symbols) ? cfg.focus_symbols.map(String) : []
    setFocusSymbolsText(frozenFocus.join(', '))
    setWatchlistSymbols([])
    setScreenerMode(cfg.screener_mode === 'manual' ? 'manual' : 'auto')
    setQueryKeys(Array.isArray(cfg.query_keys) ? cfg.query_keys.map(String) : [])
    setScreenerIds(Array.isArray(cfg.screener_ids) ? cfg.screener_ids.map(String) : [])
    setAgentModelId(cfg.agent_model || '')
    setAgentModelParams(
      Array.isArray(cfg.agent_model_params)
        ? cfg.agent_model_params
          .filter(p => p?.id && p?.value)
          .map(p => ({ id: String(p.id), value: String(p.value) }))
        : [],
    )
  }, [frozenAccountEnv, frozenConfig, isFrozen, runningSession])

  const capitalNumber = Number(capital) || 0

  const refreshEligibility = useCallback(async () => {
    if (isFrozen) return
    setChecking(true)
    setError('')
    try {
      const data = await fetchOnePercentEligibility(accountEnv, capitalNumber || 1000)
      setEligibility(data)
    } catch (err) {
      setEligibility(null)
      setError(err instanceof Error ? err.message : 'Could not verify balance')
    } finally {
      setChecking(false)
    }
  }, [accountEnv, capitalNumber, isFrozen])

  useEffect(() => {
    if (isFrozen) return
    const timer = window.setTimeout(() => {
      void refreshEligibility()
    }, 250)
    return () => window.clearTimeout(timer)
  }, [isFrozen, refreshEligibility])

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

  const toggleWatchlistSymbol = useCallback((ticker: string) => {
    const root = ticker.trim().toUpperCase().split('.', 1)[0]
    if (!root) return
    setWatchlistSymbols(prev => {
      if (prev.includes(root)) return prev.filter(item => item !== root)
      const merged = mergeFocusSymbols(prev, typedFocusSymbols, [root])
      if (!merged.includes(root)) return prev
      return [...prev, root]
    })
  }, [typedFocusSymbols])

  const toggleWatchlist = useCallback((watchlistId: string, roots: string[]) => {
    const uniqueRoots = [...new Set(roots.map(r => r.trim().toUpperCase().split('.', 1)[0]).filter(Boolean))]
    if (!uniqueRoots.length) return
    setWatchlistSymbols(prev => {
      const allSelected = uniqueRoots.every(root => prev.includes(root))
      if (allSelected) {
        const drop = new Set(uniqueRoots)
        return prev.filter(sym => !drop.has(sym))
      }
      return mergeFocusSymbols(prev, typedFocusSymbols, uniqueRoots)
    })
  }, [typedFocusSymbols])

  const manualHasSource = queryKeys.length > 0 || screenerIds.length > 0
  const canStart = !isFrozen
    && Boolean(eligibility?.can_start)
    && !checking
    && !submitting
    && (usingFocusSymbols || screenerMode === 'auto' || manualHasSource)

  const summary = useMemo(() => {
    const target = ((Number(targetPct) || 1) / 100) * (capitalNumber || 1000)
    return {
      targetDollars: target,
      label: `$${capitalNumber || 1000} · ${Number(targetPct) || 1}% target ($${target.toFixed(2)})`,
    }
  }, [capitalNumber, targetPct])

  const activeVariantName =
    selectedModel?.variants?.find(v => {
      const vp = (v.params || []).map(p => `${p.id}=${p.value}`).sort().join('|')
      const cur = [...agentModelParams].map(p => `${p.id}=${p.value}`).sort().join('|')
      return vp === cur
    })?.display_name || ''

  const handleStart = useCallback(async () => {
    if (isFrozen) return
    if (!usingFocusSymbols && screenerMode === 'manual' && !manualHasSource) {
      setError('Pick at least one built-in preset or saved screener')
      return
    }
    setSubmitting(true)
    setError('')
    try {
      const input: CreateOnePercentSessionInput = {
        account_env: accountEnv,
        capital: capitalNumber || 1000,
        target_pct: Number(targetPct) || 1,
        take_profit_pct: Number(takeProfitPct) || 1.5,
        stop_loss_pct: Number(stopLossPct) || 2,
        max_attempts: Number(maxAttempts) || 3,
        selection_mode: selectionMode,
        min_score: Number(minScore) || 0,
        screener_mode: usingFocusSymbols ? 'auto' : screenerMode,
        query_keys: !usingFocusSymbols && screenerMode === 'manual' ? queryKeys : [],
        screener_ids: !usingFocusSymbols && screenerMode === 'manual' ? screenerIds : [],
        focus_symbols: focusSymbols,
      }
      if (selectionMode === 'agent' && agentModelId) {
        input.agent_model = agentModelId
        input.agent_model_params = agentModelParams.filter(p => p.id && p.value)
      }
      const session = await createOnePercentSession(input)
      onCreated(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start session')
      void refreshEligibility()
    } finally {
      setSubmitting(false)
    }
  }, [
    accountEnv,
    agentModelId,
    agentModelParams,
    capitalNumber,
    focusSymbols,
    isFrozen,
    manualHasSource,
    maxAttempts,
    minScore,
    onCreated,
    queryKeys,
    refreshEligibility,
    screenerIds,
    screenerMode,
    selectionMode,
    stopLossPct,
    takeProfitPct,
    targetPct,
    usingFocusSymbols,
  ])

  const screenerHref = buildShellUrl({ tab: 'screener' })
  const watchTradeHref = buildShellUrl({ tab: 'watch-trade' })

  const form = (
    <div className={`opc-starter__form${embedded ? ' opc-starter__form--embedded' : ''}`}>
      {isFrozen ? (
        <div className="opc-starter__frozen-banner">
          Config locked while session is running
        </div>
      ) : null}

      <div className="opc-starter__mode" role="group" aria-label="Stock selection mode">
        <span className="opc-starter__mode-label">Stock pick</span>
        <div className="opc-starter__mode-toggle">
          <button
            type="button"
            className={`opc-mode-btn${selectionMode === 'deterministic' ? ' opc-mode-btn--active' : ''}`}
            disabled={isFrozen}
            onClick={() => setSelectionMode('deterministic')}
          >
            Algo selection
          </button>
          <button
            type="button"
            className={`opc-mode-btn${selectionMode === 'agent' ? ' opc-mode-btn--active' : ''}`}
            disabled={isFrozen}
            onClick={() => setSelectionMode('agent')}
          >
            AI agent
          </button>
        </div>
        <p className="opc-starter__mode-hint">
          {usingFocusSymbols
            ? selectionMode === 'agent'
              ? 'Watchlist / typed tickers only · AI decides place vs no-place, then auto-order if approved.'
              : 'Watchlist / typed tickers only · algo ranks those names and takes the top eToro match.'
            : selectionMode === 'agent'
              ? 'AI researches top screener hits (news, pre-market, sector/index mood) before picking.'
              : 'Ranks screener hits by momentum/liquidity score and takes the top eToro name.'}
        </p>
      </div>

      {showAgentModel ? (
        <div className="opc-starter__model">
          <span className="opc-starter__mode-label">Cursor model</span>
          <p className="opc-starter__mode-hint">
            Model and params used for AI stock selection in this session.
          </p>
          {modelsLoading && !isFrozen ? (
            <p className="opc-starter__mode-hint">Loading models…</p>
          ) : modelsError && !isFrozen ? (
            <div className="opc-starter__error">{modelsError}</div>
          ) : (
            <>
              <label className="opc-field opc-field--full">
                <span>Model</span>
                <select
                  value={agentModelId}
                  disabled={isFrozen || (!models.length && !agentModelId)}
                  onChange={event => handleModelChange(event.target.value)}
                >
                  {!models.length && agentModelId ? (
                    <option value={agentModelId}>{agentModelId}</option>
                  ) : null}
                  {!models.length && !agentModelId ? (
                    <option value="">No models available</option>
                  ) : null}
                  {models.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.display_name || m.id}
                    </option>
                  ))}
                </select>
              </label>
              {selectedModel?.description ? (
                <p className="opc-starter__mode-hint">{selectedModel.description}</p>
              ) : null}
              {selectedModel?.variants?.length && !isFrozen ? (
                <label className="opc-field opc-field--full">
                  <span>Preset</span>
                  <select
                    value={activeVariantName}
                    onChange={event => handleVariantSelect(event.target.value)}
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
              {(selectedModel?.parameters?.length || (isFrozen && agentModelParams.length > 0)) ? (
                <div className="opc-starter__model-params">
                  {selectedModel?.parameters?.length
                    ? selectedModel.parameters.map(param => (
                      <label key={param.id} className="opc-field">
                        <span>{param.display_name || param.id}</span>
                        <select
                          value={paramValueFor(agentModelParams, param.id)}
                          disabled={isFrozen}
                          onChange={event => {
                            setAgentModelParams(
                              setParamValue(agentModelParams, param.id, event.target.value),
                            )
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
                    ))
                    : agentModelParams.map(param => (
                      <label key={param.id} className="opc-field">
                        <span>{param.id}</span>
                        <input value={param.value} disabled />
                      </label>
                    ))}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      <div className="opc-starter__screeners opc-starter__watchlists">
        <div className="opc-starter__screeners-head">
          <strong>Watchlist picks</strong>
          <a className="opc-starter__screeners-link" href={watchTradeHref}>
            Open Watch &amp; Trade
          </a>
        </div>
        <p className="opc-starter__mode-hint">
          Search and multi-select eToro {accountEnv} watchlist symbols (up to {FOCUS_SYMBOL_LIMIT}
          with typed tickers). Skips screener and uses AI agent analysis.
        </p>
        <WatchlistSymbolMultiselect
          options={watchlistOptions}
          selected={watchlistSymbols}
          disabled={isFrozen}
          loading={watchlistsLoading}
          emptyHref={watchTradeHref}
          accountEnv={accountEnv}
          slotsLeft={focusSlotsLeft}
          onToggle={toggleWatchlistSymbol}
          onToggleWatchlist={toggleWatchlist}
          onClear={() => setWatchlistSymbols([])}
        />
      </div>

      <label className="opc-field opc-field--full">
        <span>Specific stocks (optional)</span>
        <input
          value={focusSymbolsText}
          disabled={isFrozen}
          onChange={event => setFocusSymbolsText(event.target.value)}
          placeholder="e.g. AAPL, NVDA, MSFT"
          title="Comma-separated tickers. Combined with watchlist picks; skips screener."
        />
      </label>
      {usingFocusSymbols ? (
        <p className="opc-starter__focus-note">
          Screener skipped · analyzing {focusSymbols.join(', ')} only
        </p>
      ) : null}

      <div className="opc-starter__grid opc-starter__grid--panel">
        <label className="opc-field">
          <span>Account</span>
          <select
            value={accountEnv}
            disabled={isFrozen}
            onChange={event => setAccountEnv(event.target.value as 'demo' | 'live')}
          >
            <option value="demo">Demo</option>
            <option value="live">Live</option>
          </select>
        </label>
        <label className="opc-field">
          <span>Capital ($)</span>
          <input
            value={capital}
            disabled={isFrozen}
            onChange={event => setCapital(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="opc-field">
          <span>Target %</span>
          <input
            value={targetPct}
            disabled={isFrozen}
            onChange={event => setTargetPct(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="opc-field">
          <span>Take profit %</span>
          <input
            value={takeProfitPct}
            disabled={isFrozen}
            onChange={event => setTakeProfitPct(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="opc-field">
          <span>Stop loss %</span>
          <input
            value={stopLossPct}
            disabled={isFrozen}
            onChange={event => setStopLossPct(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="opc-field">
          <span>Max attempts</span>
          <input
            value={maxAttempts}
            disabled={isFrozen}
            onChange={event => setMaxAttempts(event.target.value)}
            inputMode="numeric"
          />
        </label>
        {showScreenerControls ? (
          <>
            <label className="opc-field">
              <span>Min confidence score</span>
              <input
                value={minScore}
                disabled={isFrozen}
                onChange={event => setMinScore(event.target.value)}
                inputMode="decimal"
                title="Skip candidates below this rank score"
              />
            </label>
            <label className="opc-field">
              <span>Screener source</span>
              <select
                value={screenerMode}
                disabled={isFrozen}
                onChange={event => setScreenerMode(event.target.value as OnePercentScreenerMode)}
              >
                <option value="auto">Auto by market phase</option>
                <option value="manual">Manual multiselect</option>
              </select>
            </label>
          </>
        ) : null}
      </div>

      {showScreenerControls && screenerMode === 'manual' ? (
        <div className="opc-starter__screeners">
          <div className="opc-starter__screeners-head">
            <strong>Built-in presets</strong>
            <a className="opc-starter__screeners-link" href={screenerHref}>
              Create / edit screeners
            </a>
          </div>
          <div className="opc-starter__checks">
            {presets.map(preset => (
              <label key={preset.key} className="opc-check">
                <input
                  type="checkbox"
                  disabled={isFrozen}
                  checked={queryKeys.includes(preset.key)}
                  onChange={() => setQueryKeys(toggleInList(queryKeys, preset.key))}
                />
                <span>
                  <em>{preset.name}</em>
                  <small>{preset.description || preset.phase}</small>
                </span>
              </label>
            ))}
          </div>

          <div className="opc-starter__screeners-head">
            <strong>Saved screeners</strong>
          </div>
          {savedScreeners.length === 0 ? (
            <p className="opc-starter__screeners-empty">
              No saved screeners yet.{' '}
              <a href={screenerHref}>Open Screener</a> to create one.
            </p>
          ) : (
            <div className="opc-starter__checks">
              {savedScreeners.map(screener => (
                <label key={screener.id} className="opc-check">
                  <input
                    type="checkbox"
                    disabled={isFrozen}
                    checked={screenerIds.includes(screener.id)}
                    onChange={() => setScreenerIds(toggleInList(screenerIds, screener.id))}
                  />
                  <span>
                    <em>{screener.name}</em>
                    <small>{screener.total_count} cached rows</small>
                  </span>
                </label>
              ))}
            </div>
          )}
          {!isFrozen && !manualHasSource ? (
            <p className="opc-starter__warn">Select at least one preset or saved screener.</p>
          ) : null}
        </div>
      ) : showScreenerControls ? (
        <div className="opc-starter__screeners opc-starter__screeners--auto">
          <p>
            Auto picks a preset from market phase (pre-market → gainers, regular → trending,
            afterhours → hot).
          </p>
          <a className="opc-starter__screeners-link" href={screenerHref}>
            Create / edit screeners
          </a>
        </div>
      ) : null}

      {!isFrozen ? (
        <div className="opc-starter__eligibility">
          <div>
            <strong>{summary.label}</strong>
            <span>
              {checking
                ? 'Checking eToro cash…'
                : eligibility
                  ? `Available cash: ${eligibility.available_cash == null ? '—' : `$${eligibility.available_cash.toFixed(2)}`}`
                  : 'Balance not verified yet'}
            </span>
            {eligibility?.reasons?.length ? (
              <span className="opc-starter__warn">{eligibility.reasons.join(' · ')}</span>
            ) : null}
          </div>
          <button type="button" className="opc-starter__refresh" onClick={() => void refreshEligibility()} disabled={checking}>
            {checking ? 'Checking…' : 'Re-check'}
          </button>
        </div>
      ) : (
        <div className="opc-starter__eligibility opc-starter__eligibility--frozen">
          <div>
            <strong>{summary.label}</strong>
            <span>
              {runningSession
                ? `${runningSession.account_env.toUpperCase()} · ${runningSession.state} · attempt ${runningSession.attempt_count}/${runningSession.max_attempts}`
                : 'Session in progress'}
            </span>
          </div>
        </div>
      )}

      {error ? <div className="opc-starter__error">{error}</div> : null}

      {!isFrozen ? (
        <button
          type="button"
          className="opc-starter__start"
          disabled={!canStart}
          onClick={() => void handleStart()}
        >
          {submitting ? 'Starting…' : canStart ? `Start today's ${accountEnv} session` : 'Start unavailable'}
        </button>
      ) : null}
    </div>
  )

  return (
    <div className={`opc-starter${embedded ? ' opc-starter--panel' : ''}${isFrozen ? ' opc-starter--frozen' : ''}`}>
      {form}
    </div>
  )
}
