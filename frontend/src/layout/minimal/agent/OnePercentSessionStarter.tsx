import { useCallback, useEffect, useMemo, useState } from 'react'

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
import { fetchScreeners, type Screener } from '@/lib/screenerApi'
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

function toggleInList(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter(item => item !== value) : [...list, value]
}

function parseFocusSymbols(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.replace(/;/g, ',').split(/[,\s]+/)) {
    const sym = part.trim().toUpperCase().split('.', 1)[0]
    if (sym && !out.includes(sym)) out.push(sym)
    if (out.length >= 8) break
  }
  return out
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
  const [screenerMode, setScreenerMode] = useState<OnePercentScreenerMode>('auto')
  const [queryKeys, setQueryKeys] = useState<string[]>([])
  const [screenerIds, setScreenerIds] = useState<string[]>([])
  const [presets, setPresets] = useState<OnePercentPreset[]>([])
  const [savedScreeners, setSavedScreeners] = useState<Screener[]>([])
  const [eligibility, setEligibility] = useState<OnePercentEligibility | null>(null)
  const [checking, setChecking] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const focusSymbols = useMemo(() => parseFocusSymbols(focusSymbolsText), [focusSymbolsText])
  const effectiveSelectionMode: OnePercentSelectionMode = focusSymbols.length
    ? 'agent'
    : selectionMode === 'agent'
      ? 'agent'
      : 'deterministic'
  const usingFocusSymbols = focusSymbols.length > 0
  const showScreenerControls = !usingFocusSymbols

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
    setFocusSymbolsText(Array.isArray(cfg.focus_symbols) ? cfg.focus_symbols.join(', ') : '')
    setScreenerMode(cfg.screener_mode === 'manual' ? 'manual' : 'auto')
    setQueryKeys(Array.isArray(cfg.query_keys) ? cfg.query_keys.map(String) : [])
    setScreenerIds(Array.isArray(cfg.screener_ids) ? cfg.screener_ids.map(String) : [])
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
        selection_mode: effectiveSelectionMode,
        min_score: Number(minScore) || 0,
        screener_mode: usingFocusSymbols ? 'auto' : screenerMode,
        query_keys: !usingFocusSymbols && screenerMode === 'manual' ? queryKeys : [],
        screener_ids: !usingFocusSymbols && screenerMode === 'manual' ? screenerIds : [],
        focus_symbols: focusSymbols,
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
    capitalNumber,
    effectiveSelectionMode,
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
    stopLossPct,
    takeProfitPct,
    targetPct,
    usingFocusSymbols,
  ])

  const screenerHref = buildShellUrl({ tab: 'screener' })

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
            className={`opc-mode-btn${effectiveSelectionMode === 'deterministic' && !usingFocusSymbols ? ' opc-mode-btn--active' : ''}`}
            disabled={isFrozen || usingFocusSymbols}
            onClick={() => setSelectionMode('deterministic')}
          >
            Algo selection
          </button>
          <button
            type="button"
            className={`opc-mode-btn${effectiveSelectionMode === 'agent' ? ' opc-mode-btn--active' : ''}`}
            disabled={isFrozen}
            onClick={() => setSelectionMode('agent')}
          >
            AI agent
          </button>
        </div>
        <p className="opc-starter__mode-hint">
          {usingFocusSymbols
            ? 'Specific stocks force AI agent analysis with place / no-place confidence, then auto-order if approved.'
            : effectiveSelectionMode === 'agent'
              ? 'AI researches top screener hits (news, pre-market, sector/index mood) before picking.'
              : 'Ranks screener hits by momentum/liquidity score and takes the top eToro name.'}
        </p>
      </div>

      <label className="opc-field opc-field--full">
        <span>Specific stocks (optional)</span>
        <input
          value={focusSymbolsText}
          disabled={isFrozen}
          onChange={event => {
            setFocusSymbolsText(event.target.value)
            if (event.target.value.trim()) setSelectionMode('agent')
          }}
          placeholder="e.g. AAPL, NVDA, MSFT"
          title="Comma-separated tickers. Skips screener; AI decides place vs no-place."
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
