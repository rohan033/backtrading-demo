import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import SymbolLogo from '../../components/SymbolLogo'
import { PositionsPriceProvider, usePositionsPrice } from '../../context/PositionsPriceContext'
import { usePositionBracketMonitor } from '../../hooks/usePositionBracketMonitor'
import { usePositionLiveQuote } from '../../hooks/usePositionLiveQuote'
import { formatBrokerMoney } from '../../lib/currency'
import {
  CloseEtoroPositionError,
  closeEtoroPosition,
  formatCloseEtoroDebug,
  logCloseEtoroExchange,
  watchCloseSettlement,
} from '../../lib/closeEtoroPosition'
import { fetchEtoroPositions } from '../../lib/etoro-account-data'
import {
  matchesClosedPosition,
  normalizeEtoroPositions,
  positionLivePnl,
  type ClosedPositionRef,
  type EtoroPositionRow,
} from '../../lib/etoroPositions'
import {
  countEnabledBrackets,
  disableBracketsAfterClose,
  isBrokerClosablePosition,
  type MonitoredPosition,
} from '../../lib/positionBracketMonitor'
import { showPlatformToast } from '../../lib/platform-toast'
import {
  bracketStorageKey,
  bracketTargetPnl,
  bracketTargetPrice,
  formatPositionBracketSummary,
  loadPositionBracketsForRow,
  savePositionBrackets,
  type BracketValueMode,
  type PositionBracketSettings,
} from '../../lib/positionBrackets'
import {
  fetchPositionLadderStates,
  ladderLevelEstProfit,
  ladderOverallProfit,
  ladderStateByPositionId,
  resetPositionLadder,
  setPositionAutoLadder,
  type PositionLadderState,
} from '../../lib/positionLadder'
import {
  buildPortfolioSymbolIndex,
  resolvePortfolioSymbolDisplay,
  type InstrumentDisplayRecord,
} from '../../lib/portfolioSymbolDisplay'
import { buildSymbolVisualMap, type SymbolVisual } from '../../lib/symbolVisuals'
import { recordTradedInstrument } from '../../lib/tradedInstruments'
import { useEnsurePositionWatchlistFeed } from '../../hooks/useEnsurePositionWatchlistFeed'
import { fetchWatchlists, type Watchlist } from '../../lib/watchlists'
import './Positions.css'

type AccountEnv = 'demo' | 'live'

const RECENTLY_CLOSED_TTL_MS = 120_000

function markRecentlyClosed(
  store: Map<string, number>,
  closed: ClosedPositionRef,
) {
  const now = Date.now()
  if (closed.rowKey) store.set(closed.rowKey, now)
  if (closed.brokerPositionId) store.set(closed.brokerPositionId, now)
}

function filterRecentlyClosed(
  store: Map<string, number>,
  rows: EtoroPositionRow[],
): EtoroPositionRow[] {
  const cutoff = Date.now() - RECENTLY_CLOSED_TTL_MS
  for (const [key, at] of store) {
    if (at < cutoff) store.delete(key)
  }
  if (!store.size) return rows
  return rows.filter(row => {
    if (store.has(row.rowKey)) return false
    if (row.brokerPositionId && store.has(row.brokerPositionId)) return false
    if (row.positionId && store.has(row.positionId)) return false
    return true
  })
}

const EMPTY_INSTRUMENT_METADATA = new Map<string, InstrumentDisplayRecord>()

type PreparedRow = {
  row: EtoroPositionRow
  storageKey: string
  ticker: string
  name: string | null
  visual: SymbolVisual | null
}

function fmtPct(value: number) {
  if (!Number.isFinite(value)) return '—'
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}${value.toFixed(2)}%`
}

function fmtPnl(pnl: number, pnlPct: number) {
  const sign = pnl >= 0 ? '+' : ''
  const money = `${sign}$${Math.abs(pnl).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
  return `${money} (${fmtPct(pnlPct)})`
}

function fmtSignedMoney(value: number) {
  const sign = value >= 0 ? '+' : ''
  return `${sign}$${Math.abs(value).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function BracketModeToggle({
  mode,
  onChange,
}: {
  mode: BracketValueMode
  onChange: (mode: BracketValueMode) => void
}) {
  return (
    <div className="pos-mode-toggle" role="group" aria-label="Bracket value mode">
      <button
        type="button"
        className={`pos-mode-btn${mode === 'price' ? ' pos-mode-btn--active' : ''}`}
        onClick={() => onChange('price')}
        title="Target price"
      >
        Price
      </button>
      <button
        type="button"
        className={`pos-mode-btn${mode === 'percent' ? ' pos-mode-btn--active' : ''}`}
        onClick={() => onChange('percent')}
        title="Percent move from entry"
      >
        %
      </button>
      <button
        type="button"
        className={`pos-mode-btn${mode === 'amount' ? ' pos-mode-btn--active' : ''}`}
        onClick={() => onChange('amount')}
        title="Target P&L amount"
      >
        $
      </button>
    </div>
  )
}

function EnableToggle({
  enabled,
  onChange,
  label,
  disabled = false,
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className={`pos-toggle${enabled ? ' pos-toggle--on' : ''}`}
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      <span className="pos-toggle-knob" />
    </button>
  )
}

function AutoLadderCell({
  enabled,
  disabled,
  saving,
  resetting,
  ladder,
  liveMark,
  onChange,
  onReset,
}: {
  enabled: boolean
  disabled?: boolean
  saving?: boolean
  resetting?: boolean
  ladder?: PositionLadderState
  liveMark?: number | null
  onChange: (next: boolean) => void
  onReset?: () => void
}) {
  const entry = ladder?.entry_price ?? null
  const entryUnits = ladder?.entry_units ?? null
  const isBuy = ladder?.is_buy !== false
  const profitSummary = ladder ? ladderOverallProfit(ladder, liveMark) : null

  return (
    <div className="pos-auto-ladder">
      <div className="pos-auto-ladder__head">
        <span className="pos-auto-ladder__label">Auto ladder</span>
        <div className="pos-auto-ladder__actions">
          {enabled && ladder && onReset ? (
            <button
              type="button"
              className="pos-auto-ladder__reset"
              disabled={disabled || saving || resetting}
              title="Clear hit rungs and re-anchor peak from current price"
              onClick={onReset}
            >
              {resetting ? 'Resetting…' : 'Reset'}
            </button>
          ) : null}
          <EnableToggle
            enabled={enabled}
            disabled={disabled || saving || resetting}
            label={enabled ? 'Disable server auto-ladder' : 'Enable server auto-ladder'}
            onChange={onChange}
          />
        </div>
      </div>
      {enabled && ladder ? (
        <div className="pos-auto-ladder__detail">
          <span title="Session peak tracked server-side">
            Peak {ladder.peak_price != null ? formatBrokerMoney('etoro', ladder.peak_price) : '—'}
          </span>
          <span title="Original size remaining after partial trims">
            {Math.round((ladder.remaining_fraction ?? 1) * 100)}% left
          </span>
          {profitSummary ? (
            <span
              className={`pos-auto-ladder__total${profitSummary.total >= 0 ? ' pos-auto-ladder__total--up' : ' pos-auto-ladder__total--down'}`}
              title="Secured ladder trims + unrealized on remaining size at current mark"
            >
              Est total {fmtSignedMoney(profitSummary.total)}
              <span className="pos-auto-ladder__total-breakdown">
                {' '}
                (sec {fmtSignedMoney(profitSummary.secured)} · open {fmtSignedMoney(profitSummary.unrealized)})
              </span>
            </span>
          ) : null}
          <ul className="pos-auto-ladder__rungs">
            {(ladder.levels ?? []).map(level => {
              const estProfit =
                entry != null && entryUnits != null
                  ? ladderLevelEstProfit(level, entry, entryUnits, isBuy)
                  : null
              const profitUp = (estProfit ?? 0) >= 0
              return (
                <li
                  key={level.id}
                  className={`pos-auto-ladder__rung${level.hit ? ' pos-auto-ladder__rung--hit' : ''}`}
                >
                  <strong>{level.id}</strong>
                  <span>{formatBrokerMoney('etoro', level.price)}</span>
                  {estProfit != null ? (
                    <span
                      className={`pos-auto-ladder__rung-pnl${profitUp ? ' pos-auto-ladder__rung-pnl--up' : ' pos-auto-ladder__rung-pnl--down'}`}
                      title={
                        level.hit
                          ? 'Estimated profit secured on this 25% trim'
                          : 'Estimated profit if this 25% trim executes at this rung'
                      }
                    >
                      {level.hit ? fmtSignedMoney(estProfit) : `est ${fmtSignedMoney(estProfit)}`}
                    </span>
                  ) : null}
                  {level.hit ? <em>hit</em> : null}
                </li>
              )
            })}
          </ul>
        </div>
      ) : (
        <p className="pos-auto-ladder__hint">
          Server-side partial trims on pullback — rungs extend with peak (L4+ at higher gains).
          Works alongside single TP.
        </p>
      )}
    </div>
  )
}

function BracketCell({
  kind,
  settings,
  openRate,
  units,
  isBuy,
  liveMark,
  onChange,
  disabled = false,
}: {
  kind: 'take_profit' | 'stop_loss'
  settings: PositionBracketSettings
  openRate: number
  units: number
  isBuy: boolean
  liveMark?: number | null
  onChange: (patch: Partial<PositionBracketSettings>) => void
  disabled?: boolean
}) {
  const mode = kind === 'take_profit' ? settings.takeProfitMode : settings.stopLossMode
  const value = kind === 'take_profit' ? settings.takeProfitValue : settings.stopLossValue
  const hasValue = value.trim().length > 0
  const targetPrice = hasValue
    ? bracketTargetPrice(mode, value, openRate, units, isBuy, kind)
    : null
  const targetPnl = hasValue
    ? bracketTargetPnl(mode, value, openRate, units, isBuy, kind)
    : null
  const tpBelowMarket = kind === 'take_profit'
    && targetPrice != null
    && liveMark != null
    && liveMark > 0
    && (isBuy ? targetPrice <= liveMark : targetPrice >= liveMark)
  const slBeyondMarket = kind === 'stop_loss'
    && targetPrice != null
    && liveMark != null
    && liveMark > 0
    && (isBuy ? targetPrice >= liveMark : targetPrice <= liveMark)
  const bracketReached = tpBelowMarket || slBeyondMarket

  return (
    <div className="pos-bracket-stack">
      <BracketModeToggle
        mode={mode}
        onChange={next => {
          onChange(kind === 'take_profit' ? { takeProfitMode: next } : { stopLossMode: next })
        }}
      />
      <input
        type="number"
        className="pos-bracket-input"
        value={value}
        disabled={disabled}
        step={mode === 'price' ? 0.01 : mode === 'percent' ? 0.1 : 1}
        placeholder={mode === 'price' ? 'Price' : mode === 'percent' ? '%' : 'Amount'}
        onChange={e => {
          const nextValue = e.target.value
          if (kind === 'take_profit') {
            onChange({ takeProfitValue: nextValue })
            return
          }
          onChange({ stopLossValue: nextValue })
        }}
      />
      {hasValue && targetPrice != null ? (
        <div className={`pos-bracket-hint${bracketReached ? ' pos-bracket-hint--warn' : ''}`}>
          {mode === 'amount'
            ? `Target ${formatBrokerMoney('etoro', targetPrice)}`
            : mode === 'percent'
              ? `Target ${formatBrokerMoney('etoro', targetPrice)}${targetPnl != null ? ` · P&L ${fmtSignedMoney(targetPnl)}` : ''}`
              : targetPnl != null
                ? `P&L ${fmtSignedMoney(targetPnl)}`
                : null}
          {bracketReached ? (
            <span>
              {' '}
              · {kind === 'take_profit' ? 'target reached' : 'stop reached'} — monitoring will close
            </span>
          ) : null}
        </div>
      ) : kind === 'take_profit' && liveMark != null && liveMark > 0 ? (
        <div className="pos-bracket-hint">
          Set TP {isBuy ? 'above' : 'below'} current {formatBrokerMoney('etoro', liveMark)}
        </div>
      ) : null}
    </div>
  )
}

const PositionLivePnlCell = memo(function PositionLivePnlCell({
  row,
  accountEnv,
  ticker,
}: {
  row: EtoroPositionRow
  accountEnv: AccountEnv
  ticker: string
}) {
  const { reportPrice } = usePositionsPrice()
  const quote = usePositionLiveQuote({
    accountEnv,
    symboltoken: row.symboltoken,
    tradingsymbol: row.tradingsymbol,
    ticker,
    openRate: row.openRate,
    quantity: row.quantity,
    isBuy: row.isBuy,
    brokerLtp: row.brokerLtp,
    brokerPnl: row.brokerPnl,
  })

  useEffect(() => {
    reportPrice(row.rowKey, quote.mark)
  }, [quote.mark, reportPrice, row.rowKey])

  const pnlUp = (quote.pnl ?? 0) >= 0

  return (
    <>
      <td className="pos-td-num" title={quote.stale ? quote.statusLabel : undefined}>
        <span className="pos-price-box pos-price-box--current">
          {quote.mark != null ? formatBrokerMoney('etoro', quote.mark) : '—'}
        </span>
        {quote.stale && quote.mark != null ? (
          <span className="pos-price-stale" aria-label={quote.statusLabel}> ↻</span>
        ) : null}
      </td>
      <td className={`pos-td-num ${pnlUp ? 'pos-pnl--up' : 'pos-pnl--down'}`}>
        {quote.pnl != null ? fmtPnl(quote.pnl, quote.pnlPct) : '—'}
      </td>
    </>
  )
})

function matchesTickerFilter(prepared: PreparedRow, query: string): boolean {
  const needle = query.trim().toUpperCase()
  if (!needle) return true
  const ticker = prepared.ticker.toUpperCase()
  const symbol = prepared.row.tradingsymbol.toUpperCase()
  const name = String(prepared.name || '').toUpperCase()
  return ticker.includes(needle) || symbol.includes(needle) || name.includes(needle)
}

function matchesSelectedTickers(prepared: PreparedRow, selected: Set<string>): boolean {
  if (selected.size === 0) return true
  return selected.has(prepared.ticker.toUpperCase())
}

function rowMatchesFilters(prepared: PreparedRow, query: string, selected: Set<string>): boolean {
  return matchesTickerFilter(prepared, query) && matchesSelectedTickers(prepared, selected)
}

const PositionTableRow = memo(function PositionTableRow({
  prepared,
  accountEnv,
  closing,
  hidden,
  ladder,
  ladderSaving,
  ladderResetting,
  onBracketsUpdated,
  onLadderToggle,
  onLadderReset,
  onClose,
}: {
  prepared: PreparedRow
  accountEnv: AccountEnv
  closing?: boolean
  hidden?: boolean
  ladder?: PositionLadderState
  ladderSaving?: boolean
  ladderResetting?: boolean
  onBracketsUpdated?: () => void
  onLadderToggle?: (enabled: boolean) => void
  onLadderReset?: () => void
  onClose?: () => void
}) {
  const { row, storageKey, ticker, name, visual } = prepared
  const autoLadder = Boolean(ladder?.auto_ladder_enabled)
  const { prices } = usePositionsPrice()
  const liveMark = prices[row.rowKey] ?? row.brokerLtp ?? null
  const [brackets, setBrackets] = useState(() =>
    loadPositionBracketsForRow(accountEnv, storageKey, [row.brokerPositionId, row.positionId, row.symboltoken]),
  )

  useEffect(() => {
    setBrackets(loadPositionBracketsForRow(accountEnv, storageKey, [row.brokerPositionId, row.positionId, row.symboltoken]))
  }, [accountEnv, storageKey, row.positionId, row.symboltoken])

  const onBracketsChange = useCallback((patch: Partial<PositionBracketSettings>) => {
    setBrackets(prev => {
      const next = savePositionBrackets(accountEnv, storageKey, patch, prev)
      queueMicrotask(() => onBracketsUpdated?.())
      return next
    })
  }, [accountEnv, onBracketsUpdated, storageKey])

  const monitoring = autoLadder || Boolean(
    (brackets.takeProfitEnabled && brackets.takeProfitValue.trim())
    || (brackets.stopLossEnabled && brackets.stopLossValue.trim()),
  )

  return (
    <tr
      className={[
        closing ? 'pos-row--closing' : '',
        hidden ? 'pos-row--hidden' : '',
        monitoring ? 'pos-row--monitoring' : '',
      ].filter(Boolean).join(' ') || undefined}
      aria-hidden={hidden || undefined}
    >
      <td>
        <div className="pos-sym-cell">
          <span className="pos-sym-icon">
            <SymbolLogo
              symbol={ticker}
              visual={visual || {
                ticker,
                logo35x35: row.logo35x35,
                logo50x50: row.logo50x50,
                logo150x150: row.logo150x150,
              }}
            />
          </span>
          <div className="pos-sym-label">
            <div className="pos-sym-ticker">
              {ticker}
              {monitoring ? (
                <span className="pos-monitor-badge">
                  {autoLadder ? 'Auto ladder' : 'Monitoring'}
                </span>
              ) : null}
            </div>
            {name ? <div className="pos-sym-name">{name}</div> : null}
            <div className={`pos-side${row.isBuy ? '' : ' pos-side--sell'}`}>
              {row.isBuy ? 'Long' : 'Short'}
            </div>
          </div>
        </div>
      </td>
      <td className="pos-td-num">{row.quantity.toLocaleString()}</td>
      <td className="pos-td-num">
        <span className="pos-price-box pos-price-box--buy">
          {formatBrokerMoney('etoro', row.openRate)}
        </span>
      </td>
      <PositionLivePnlCell row={row} accountEnv={accountEnv} ticker={ticker} />
      <td className="pos-bracket-cell">
        <BracketCell
          kind="take_profit"
          settings={brackets}
          openRate={row.openRate}
          units={row.quantity}
          isBuy={row.isBuy}
          liveMark={liveMark}
          onChange={onBracketsChange}
        />
      </td>
      <td>
        <EnableToggle
          enabled={brackets.takeProfitEnabled}
          label="Enable take profit"
          onChange={takeProfitEnabled => onBracketsChange({ takeProfitEnabled })}
        />
      </td>
      <td className="pos-bracket-cell">
        <BracketCell
          kind="stop_loss"
          settings={brackets}
          openRate={row.openRate}
          units={row.quantity}
          isBuy={row.isBuy}
          liveMark={liveMark}
          onChange={onBracketsChange}
        />
      </td>
      <td>
        <EnableToggle
          enabled={brackets.stopLossEnabled}
          label="Enable stop loss"
          onChange={stopLossEnabled => onBracketsChange({ stopLossEnabled })}
        />
      </td>
      <td className="pos-auto-ladder-col">
        <AutoLadderCell
          enabled={autoLadder}
          disabled={!isBrokerClosablePosition(row)}
          saving={ladderSaving}
          resetting={ladderResetting}
          ladder={ladder}
          liveMark={liveMark}
          onChange={next => onLadderToggle?.(next)}
          onReset={onLadderReset}
        />
      </td>
      <td className="pos-td-actions">
        <button
          type="button"
          className="pos-close-btn"
          disabled={closing || !isBrokerClosablePosition(row)}
          title={
            isBrokerClosablePosition(row)
              ? `Close ${ticker} position (${row.brokerPositionId})`
              : 'Refresh positions to load broker position id before closing'
          }
          onClick={() => onClose?.()}
        >
          {closing ? 'Closing…' : 'Close'}
        </button>
      </td>
    </tr>
  )
})

function PositionsTable({
  accountEnv,
  onAccountEnvChange,
  preparedRows,
  loading,
  error,
  positions,
  lastRefreshedAt,
  onRefresh,
  onPositionClosed,
}: {
  accountEnv: AccountEnv
  onAccountEnvChange: (env: AccountEnv) => void
  preparedRows: PreparedRow[]
  loading: boolean
  error: string
  positions: EtoroPositionRow[]
  lastRefreshedAt: number | null
  onRefresh: () => void
  onPositionClosed: (closed: ClosedPositionRef) => void
}) {
  const { prices } = usePositionsPrice()
  const [bracketRevision, setBracketRevision] = useState(0)
  const [tickerFilter, setTickerFilter] = useState('')
  const [selectedTickers, setSelectedTickers] = useState<Set<string>>(() => new Set())
  const [manualClosingKeys, setManualClosingKeys] = useState<Set<string>>(() => new Set())
  const [ladderRows, setLadderRows] = useState<PositionLadderState[]>([])
  const [ladderSavingId, setLadderSavingId] = useState('')
  const [ladderResettingId, setLadderResettingId] = useState('')
  const bumpBracketRevision = useCallback(() => setBracketRevision(v => v + 1), [])

  const loadLadderStates = useCallback(async () => {
    try {
      const rows = await fetchPositionLadderStates(accountEnv)
      setLadderRows(rows)
    } catch {
      // Non-fatal — ladder UI falls back to local toggle only.
    }
  }, [accountEnv])

  useEffect(() => {
    void loadLadderStates()
    const timer = window.setInterval(() => { void loadLadderStates() }, 8000)
    return () => window.clearInterval(timer)
  }, [loadLadderStates])

  const ladderByPositionId = useMemo(
    () => ladderStateByPositionId(ladderRows),
    [ladderRows],
  )

  const autoLadderPositionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const row of ladderRows) {
      if (row.auto_ladder_enabled && row.broker_position_id) {
        ids.add(row.broker_position_id)
      }
    }
    return ids
  }, [ladderRows])

  const tickerOptions = useMemo(
    () => [...new Set(preparedRows.map(row => row.ticker))].sort(),
    [preparedRows],
  )

  const filterQuery = tickerFilter.trim()
  const hasActiveFilter = filterQuery.length > 0 || selectedTickers.size > 0

  const toggleTicker = useCallback((ticker: string) => {
    const key = ticker.toUpperCase()
    setSelectedTickers(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const clearAllFilters = useCallback(() => {
    setTickerFilter('')
    setSelectedTickers(new Set())
  }, [])

  const filterLabel = useMemo(
    () => [filterQuery, ...[...selectedTickers]].filter(Boolean).join(', '),
    [filterQuery, selectedTickers],
  )

  const visibleCount = useMemo(() => {
    if (!hasActiveFilter) return preparedRows.length
    return preparedRows.filter(row => rowMatchesFilters(row, filterQuery, selectedTickers)).length
  }, [hasActiveFilter, filterQuery, selectedTickers, preparedRows])

  const monitoredRows = useMemo((): MonitoredPosition[] => {
    void bracketRevision
    return preparedRows.map(prepared => ({
      row: prepared.row,
      storageKey: prepared.storageKey,
      ticker: prepared.ticker,
    }))
  }, [bracketRevision, preparedRows])

  const handlePositionClosed = useCallback((closed: ClosedPositionRef) => {
    bumpBracketRevision()
    if (closed.rowKey && filterQuery) {
      const prepared = preparedRows.find(item => item.row.rowKey === closed.rowKey)
      if (prepared && matchesTickerFilter(prepared, filterQuery)) {
        setTickerFilter('')
      }
    }
    onPositionClosed(closed)
  }, [bumpBracketRevision, filterQuery, onPositionClosed, preparedRows])

  const { closingKeys } = usePositionBracketMonitor({
    accountEnv,
    rows: monitoredRows,
    prices,
    autoLadderPositionIds,
    enabled: preparedRows.length > 0,
    onClosed: handlePositionClosed,
  })

  const enabledBracketCount = useMemo(
    () => countEnabledBrackets(accountEnv, monitoredRows, autoLadderPositionIds),
    [accountEnv, autoLadderPositionIds, bracketRevision, monitoredRows],
  )

  const handleAutoLadderToggle = useCallback(async (prepared: PreparedRow, enabled: boolean) => {
    const { row, ticker } = prepared
    if (!row.brokerPositionId) {
      showPlatformToast({
        variant: 'error',
        title: 'Cannot arm ladder',
        message: `${ticker}: refresh positions to load broker id first.`,
        duration: 8000,
      })
      return
    }
    setLadderSavingId(row.brokerPositionId)
    try {
      const instrumentId = Number(row.symboltoken)
      await setPositionAutoLadder(accountEnv, row.brokerPositionId, {
        enabled,
        ticker,
        instrument_id: Number.isFinite(instrumentId) ? instrumentId : null,
        entry_price: row.openRate,
        entry_units: row.quantity,
        is_buy: row.isBuy,
      })
      await loadLadderStates()
      showPlatformToast({
        variant: 'success',
        title: enabled ? 'Auto ladder armed' : 'Auto ladder off',
        message: enabled
          ? `${ticker}: server monitors partial trims on pullback (rungs extend with peak).`
          : `${ticker}: ladder monitoring stopped.`,
        duration: 8000,
      })
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        title: 'Auto ladder update failed',
        message: err instanceof Error ? err.message : 'Request failed',
        duration: 10000,
      })
    } finally {
      setLadderSavingId('')
    }
  }, [accountEnv, loadLadderStates])

  const handleResetLadder = useCallback(async (prepared: PreparedRow) => {
    const { row, ticker } = prepared
    if (!row.brokerPositionId) {
      showPlatformToast({
        variant: 'error',
        title: 'Cannot reset ladder',
        message: `${ticker}: refresh positions to load broker id first.`,
        duration: 8000,
      })
      return
    }
    const liveMark = prices[row.rowKey] ?? row.brokerLtp ?? row.openRate
    setLadderResettingId(row.brokerPositionId)
    try {
      await resetPositionLadder(accountEnv, row.brokerPositionId, {
        ticker,
        entry_price: row.openRate,
        entry_units: row.quantity,
        peak_price: liveMark,
      })
      await loadLadderStates()
      showPlatformToast({
        variant: 'success',
        title: 'Ladder reset',
        message: `${ticker}: rungs cleared, peak re-anchored from current mark.`,
        duration: 8000,
      })
    } catch (err) {
      showPlatformToast({
        variant: 'error',
        title: 'Ladder reset failed',
        message: err instanceof Error ? err.message : 'Request failed',
        duration: 10000,
      })
    } finally {
      setLadderResettingId('')
    }
  }, [accountEnv, loadLadderStates, prices])

  const handleClosePosition = useCallback(async (prepared: PreparedRow) => {
    const { row, ticker, storageKey, name } = prepared
    if (!isBrokerClosablePosition(row) || !row.brokerPositionId) {
      showPlatformToast({
        variant: 'error',
        title: 'Cannot close',
        message: `${ticker}: broker position id missing. Hit Refresh to reload from eToro.`,
        duration: 8000,
      })
      return
    }

    setManualClosingKeys(prev => new Set(prev).add(row.rowKey))
    try {
      const brackets = loadPositionBracketsForRow(accountEnv, storageKey, [
        row.brokerPositionId,
        row.positionId,
        row.symboltoken,
      ])
      const bracketSummary = formatPositionBracketSummary(brackets)
      const sellPrice = prices[row.rowKey] ?? row.brokerLtp
      const live = positionLivePnl(row, sellPrice)
      const result = await closeEtoroPosition(row.brokerPositionId!, accountEnv, {
        instrumentId: row.symboltoken,
        notify: {
          source: 'positions',
          ticker,
          symbol_name: prepared.name,
          buy_price: row.openRate,
          sell_price: sellPrice,
          pnl: live?.pnl ?? row.brokerPnl,
          pnl_pct: live?.pnlPct,
          close_reason: 'manual',
          take_profit_config: bracketSummary.takeProfit,
          stop_loss_config: bracketSummary.stopLoss,
        },
      })
      logCloseEtoroExchange(ticker, result)
      watchCloseSettlement(result, ticker)
      void recordTradedInstrument({
        symboltoken: row.symboltoken,
        tradingsymbol: ticker,
        account_env: accountEnv,
        symbol: name || row.displayName || undefined,
        instrument_display_name: name || row.displayName || undefined,
        logo35x35: row.logo35x35 ?? undefined,
        logo50x50: row.logo50x50 ?? undefined,
        logo150x150: row.logo150x150 ?? undefined,
        position_id: row.brokerPositionId || row.positionId,
        side: row.isBuy ? 'buy' : 'sell',
        bump_trade_count: true,
      }).catch(() => {})
      disableBracketsAfterClose(accountEnv, storageKey)
      bumpBracketRevision()
      const closedRef: ClosedPositionRef = {
        rowKey: row.rowKey,
        brokerPositionId: row.brokerPositionId,
      }
      showPlatformToast({
        variant: 'success',
        title: 'Position closed',
        message: `${ticker} · ${row.brokerPositionId}`,
        duration: 8000,
      })
      if (filterQuery && matchesTickerFilter(prepared, filterQuery)) {
        setTickerFilter('')
      }
      onPositionClosed(closedRef)
    } catch (error) {
      const closeError = error instanceof CloseEtoroPositionError ? error : null
      logCloseEtoroExchange(ticker, null, closeError)
      const debugText = formatCloseEtoroDebug(closeError?.debug)
      const message = error instanceof Error ? error.message : 'Could not close position'
      showPlatformToast({
        variant: 'error',
        title: 'Close failed',
        message: debugText ? `${message}\n\n${debugText}` : message,
        duration: 20000,
      })
    } finally {
      setManualClosingKeys(prev => {
        const next = new Set(prev)
        next.delete(row.rowKey)
        return next
      })
    }
  }, [accountEnv, bumpBracketRevision, filterQuery, onPositionClosed, prices])

  const refreshedLabel = lastRefreshedAt
    ? new Date(lastRefreshedAt).toLocaleTimeString()
    : null

  return (
    <div className="pos-root">
      <div className="pos-toolbar">
        <div className="pos-env-toggle" role="group" aria-label="Account environment">
          <button
            type="button"
            className={`pos-env-btn${accountEnv === 'demo' ? ' pos-env-btn--active' : ''}`}
            onClick={() => onAccountEnvChange('demo')}
          >
            Demo
          </button>
          <button
            type="button"
            className={`pos-env-btn pos-env-btn--live${accountEnv === 'live' ? ' pos-env-btn--active' : ''}`}
            onClick={() => onAccountEnvChange('live')}
          >
            Live
          </button>
        </div>
        <button
          type="button"
          className="pos-btn"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
        <label className="pos-filter">
          <span className="pos-filter__label">Ticker</span>
          <span className="pos-filter__input-wrap">
            <input
              type="search"
              className="pos-filter__input"
              value={tickerFilter}
              placeholder="All"
              onChange={e => setTickerFilter(e.target.value)}
            />
            {tickerFilter ? (
              <button
                type="button"
                className="pos-filter__clear"
                aria-label="Clear ticker filter"
                onClick={() => setTickerFilter('')}
              >
                ×
              </button>
            ) : null}
          </span>
        </label>
        {tickerOptions.length > 1 ? (
          <div className="pos-ticker-pills" role="list" aria-label="Quick ticker filters (multi-select)">
            {tickerOptions.map(ticker => {
              const active = selectedTickers.has(ticker.toUpperCase())
              return (
                <button
                  key={ticker}
                  type="button"
                  role="listitem"
                  aria-pressed={active}
                  className={`pos-ticker-pill${active ? ' pos-ticker-pill--active' : ''}`}
                  onClick={() => toggleTicker(ticker)}
                >
                  {ticker}
                </button>
              )
            })}
            {hasActiveFilter ? (
              <button
                type="button"
                className="pos-ticker-pill pos-ticker-pill--clear"
                onClick={clearAllFilters}
                title="Clear all ticker filters"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="pos-toolbar-spacer" />
        <span
          className={`pos-toolbar-meta pos-toolbar-meta--monitor${enabledBracketCount > 0 ? '' : ' pos-toolbar-meta--monitor-idle'}`}
          title={
            enabledBracketCount > 0
              ? 'Client TP/SL or server auto-ladder — armed positions are monitored'
              : 'Turn on auto-ladder or TP/SL to start monitoring'
          }
        >
          {enabledBracketCount > 0
            ? `Monitoring ${enabledBracketCount} position${enabledBracketCount === 1 ? '' : 's'}`
            : 'Monitoring idle'}
        </span>
        {refreshedLabel ? (
          <span className="pos-toolbar-meta">Updated {refreshedLabel}</span>
        ) : null}
        <span className="pos-toolbar-meta">
          {hasActiveFilter
            ? `${visibleCount} / ${positions.length} shown`
            : `${positions.length} position${positions.length === 1 ? '' : 's'}`}
        </span>
      </div>

      <div className="pos-body">
        {loading && !positions.length ? (
          <div className="pos-empty">Loading positions…</div>
        ) : error && !positions.length ? (
          <div className="pos-empty">{error}</div>
        ) : !positions.length ? (
          <div className="pos-empty">No open eToro positions.</div>
        ) : (
          <div className="pos-table-scroll">
            <div className="pos-table-card">
              <table className="pos-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Qty</th>
                    <th>Buy</th>
                    <th>Current</th>
                    <th>P&amp;L</th>
                    <th>Take profit</th>
                    <th>TP</th>
                    <th>Stop loss</th>
                    <th>SL</th>
                    <th>Auto ladder</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {hasActiveFilter && visibleCount === 0 ? (
                    <tr className="pos-filter-empty-row">
                      <td colSpan={11}>
                        <div className="pos-filter-empty">
                          No positions match “{filterLabel}”.
                          <button
                            type="button"
                            className="pos-empty-clear"
                            onClick={clearAllFilters}
                          >
                            Clear filter
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  {preparedRows.map(prepared => {
                    const isClosing = closingKeys.has(prepared.row.rowKey)
                      || manualClosingKeys.has(prepared.row.rowKey)
                    const hidden = !rowMatchesFilters(prepared, filterQuery, selectedTickers)
                    return (
                      <PositionTableRow
                        key={prepared.row.rowKey}
                        prepared={prepared}
                        accountEnv={accountEnv}
                        closing={isClosing}
                        hidden={hidden}
                        ladder={prepared.row.brokerPositionId
                          ? ladderByPositionId[prepared.row.brokerPositionId]
                          : undefined}
                        ladderSaving={Boolean(
                          prepared.row.brokerPositionId
                          && ladderSavingId === prepared.row.brokerPositionId,
                        )}
                        ladderResetting={Boolean(
                          prepared.row.brokerPositionId
                          && ladderResettingId === prepared.row.brokerPositionId,
                        )}
                        onBracketsUpdated={bumpBracketRevision}
                        onLadderToggle={enabled => {
                          void handleAutoLadderToggle(prepared, enabled)
                        }}
                        onLadderReset={() => { void handleResetLadder(prepared) }}
                        onClose={() => { void handleClosePosition(prepared) }}
                      />
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default function Positions() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([])
  const [accountEnv, setAccountEnv] = useState<AccountEnv>('demo')
  const [positions, setPositions] = useState<EtoroPositionRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const recentlyClosedRef = useRef<Map<string, number>>(new Map())

  const visualMap = useMemo(() => buildSymbolVisualMap(watchlists), [watchlists])
  const watchlistIndex = useMemo(
    () => buildPortfolioSymbolIndex(watchlists, 'etoro', accountEnv),
    [watchlists, accountEnv],
  )

  const positionFeedTargets = useMemo(
    () =>
      positions
        .filter(row => row.symboltoken.trim())
        .map(row => ({
          symboltoken: row.symboltoken,
          tradingsymbol: row.tradingsymbol,
          symbol: row.displayName,
        })),
    [positions],
  )
  useEnsurePositionWatchlistFeed(accountEnv, positionFeedTargets)

  const preparedRows = useMemo((): PreparedRow[] => {
    return positions.map(row => {
      const storageKey = bracketStorageKey(row.brokerPositionId || row.positionId, row.rowKey)
      const display = resolvePortfolioSymbolDisplay(
        {
          tradingsymbol: row.tradingsymbol,
          symbol: row.displayName || undefined,
          symboltoken: row.symboltoken,
          exchange: 'ETORO',
          quantity: String(row.quantity),
          averageprice: String(row.openRate),
          ltp: row.brokerLtp != null ? String(row.brokerLtp) : '',
          broker: 'etoro',
          logo35x35: row.logo35x35,
          logo50x50: row.logo50x50,
          logo150x150: row.logo150x150,
        },
        watchlistIndex,
        visualMap,
        EMPTY_INSTRUMENT_METADATA,
      )
      return {
        row,
        storageKey,
        ticker: display.ticker,
        name: display.name,
        visual: display.visual,
      }
    })
  }, [positions, watchlistIndex, visualMap])

  useEffect(() => {
    let cancelled = false
    void fetchWatchlists().then(rows => {
      if (!cancelled) setWatchlists(rows)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const loadPositions = useCallback(async ({ refresh = false, silent = false } = {}) => {
    if (!silent) setLoading(true)
    setError('')
    try {
      const response = await fetchEtoroPositions(accountEnv, { refresh })
      if (!response.status) {
        setPositions([])
        setError(response.message || 'Failed to load positions')
        return
      }
      const rows = filterRecentlyClosed(
        recentlyClosedRef.current,
        normalizeEtoroPositions(response),
      )
      setPositions(rows)
      setLastRefreshedAt(Date.now())
      if (!rows.length) {
        setError(`No open positions on eToro (${accountEnv.toUpperCase()}).`)
      } else {
        setError('')
      }
    } catch (err) {
      setPositions([])
      setError(err instanceof Error ? err.message : 'Positions request failed')
    } finally {
      if (!silent) setLoading(false)
    }
  }, [accountEnv])

  const handlePositionClosed = useCallback((closed: ClosedPositionRef) => {
    markRecentlyClosed(recentlyClosedRef.current, closed)
    setPositions(prev => {
      const next = prev.filter(row => !matchesClosedPosition(row, closed))
      if (!next.length) {
        setError(`No open positions on eToro (${accountEnv.toUpperCase()}).`)
      }
      return next
    })
    setLastRefreshedAt(Date.now())
    void loadPositions({ refresh: true, silent: true })
  }, [accountEnv, loadPositions])

  useEffect(() => {
    void loadPositions({ refresh: true })
  }, [loadPositions])

  // eToro /pnl is cached ~10s — keep broker marks fresh when websocket stalls.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void loadPositions({ refresh: true, silent: true })
    }, 12000)
    return () => window.clearInterval(interval)
  }, [loadPositions])

  return (
    <PositionsPriceProvider>
      <PositionsTable
        accountEnv={accountEnv}
        onAccountEnvChange={setAccountEnv}
        preparedRows={preparedRows}
        loading={loading}
        error={error}
        positions={positions}
        lastRefreshedAt={lastRefreshedAt}
        onRefresh={() => { void loadPositions({ refresh: true }) }}
        onPositionClosed={handlePositionClosed}
      />
    </PositionsPriceProvider>
  )
}
