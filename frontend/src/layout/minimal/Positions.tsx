import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import SymbolLogo from '../../components/SymbolLogo'
import { PositionsPriceProvider, usePositionsPrice } from '../../context/PositionsPriceContext'
import { usePositionBracketMonitor } from '../../hooks/usePositionBracketMonitor'
import { useMarketPreviewFeed } from '../../hooks/useMarketPreviewFeed'
import { formatBrokerMoney } from '../../lib/currency'
import {
  CloseEtoroPositionError,
  closeEtoroPosition,
  formatCloseEtoroDebug,
  logCloseEtoroExchange,
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
  loadPositionBracketsForRow,
  savePositionBrackets,
  type BracketValueMode,
  type PositionBracketSettings,
} from '../../lib/positionBrackets'
import {
  buildPortfolioSymbolIndex,
  resolvePortfolioSymbolDisplay,
  type InstrumentDisplayRecord,
} from '../../lib/portfolioSymbolDisplay'
import { buildSymbolVisualMap, type SymbolVisual } from '../../lib/symbolVisuals'
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
}: {
  enabled: boolean
  onChange: (enabled: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      className={`pos-toggle${enabled ? ' pos-toggle--on' : ''}`}
      onClick={() => onChange(!enabled)}
      aria-pressed={enabled}
      aria-label={label}
      title={label}
    >
      <span className="pos-toggle-knob" />
    </button>
  )
}

function BracketCell({
  kind,
  settings,
  openRate,
  units,
  isBuy,
  onChange,
}: {
  kind: 'take_profit' | 'stop_loss'
  settings: PositionBracketSettings
  openRate: number
  units: number
  isBuy: boolean
  onChange: (patch: Partial<PositionBracketSettings>) => void
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
        step={mode === 'price' ? 0.01 : 1}
        placeholder={mode === 'price' ? 'Price' : 'Amount'}
        onChange={e =>
          onChange(
            kind === 'take_profit'
              ? { takeProfitValue: e.target.value }
              : { stopLossValue: e.target.value },
          )}
      />
      {hasValue && targetPrice != null ? (
        <div className="pos-bracket-hint">
          {mode === 'amount'
            ? `Target ${formatBrokerMoney('etoro', targetPrice)}`
            : targetPnl != null
              ? `P&L ${fmtSignedMoney(targetPnl)}`
              : null}
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
  const { ltp } = useMarketPreviewFeed({
    broker: 'etoro',
    token: row.symboltoken || ticker,
    symbol: row.tradingsymbol || ticker,
    exchange: 'ETORO',
    account_env: accountEnv,
    feed_mode: 'websocket',
    enabled: Boolean(row.symboltoken || ticker),
  })

  useEffect(() => {
    reportPrice(row.rowKey, ltp)
  }, [ltp, reportPrice, row.rowKey])

  const live = positionLivePnl(row, ltp)
  const pnl = live?.pnl ?? row.brokerPnl
  const pnlPct = live?.pnlPct ?? 0
  const pnlUp = (pnl ?? 0) >= 0

  return (
    <td className={`pos-td-num ${pnlUp ? 'pos-pnl--up' : 'pos-pnl--down'}`}>
      {pnl != null ? fmtPnl(pnl, pnlPct) : '—'}
    </td>
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

const PositionTableRow = memo(function PositionTableRow({
  prepared,
  accountEnv,
  closing,
  hidden,
  onBracketsUpdated,
  onClose,
}: {
  prepared: PreparedRow
  accountEnv: AccountEnv
  closing?: boolean
  hidden?: boolean
  onBracketsUpdated?: () => void
  onClose?: () => void
}) {
  const { row, storageKey, ticker, name, visual } = prepared
  const [brackets, setBrackets] = useState(() =>
    loadPositionBracketsForRow(accountEnv, storageKey, [row.brokerPositionId, row.positionId, row.symboltoken]),
  )

  useEffect(() => {
    setBrackets(loadPositionBracketsForRow(accountEnv, storageKey, [row.brokerPositionId, row.positionId, row.symboltoken]))
  }, [accountEnv, storageKey, row.positionId, row.symboltoken])

  const onBracketsChange = useCallback((patch: Partial<PositionBracketSettings>) => {
    const next = savePositionBrackets(accountEnv, storageKey, patch)
    setBrackets(next)
    if ('takeProfitEnabled' in patch || 'stopLossEnabled' in patch) {
      onBracketsUpdated?.()
    }
  }, [accountEnv, onBracketsUpdated, storageKey])

  return (
    <tr
      className={[
        closing ? 'pos-row--closing' : '',
        hidden ? 'pos-row--hidden' : '',
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
            <div className="pos-sym-ticker">{ticker}</div>
            {name ? <div className="pos-sym-name">{name}</div> : null}
            <div className={`pos-side${row.isBuy ? '' : ' pos-side--sell'}`}>
              {row.isBuy ? 'Long' : 'Short'}
            </div>
          </div>
        </div>
      </td>
      <td className="pos-td-num">{row.quantity.toLocaleString()}</td>
      <td className="pos-td-num">{formatBrokerMoney('etoro', row.openRate)}</td>
      <PositionLivePnlCell row={row} accountEnv={accountEnv} ticker={ticker} />
      <td className="pos-bracket-cell">
        <BracketCell
          kind="take_profit"
          settings={brackets}
          openRate={row.openRate}
          units={row.quantity}
          isBuy={row.isBuy}
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
  const [manualClosingKeys, setManualClosingKeys] = useState<Set<string>>(() => new Set())
  const bumpBracketRevision = useCallback(() => setBracketRevision(v => v + 1), [])

  const tickerOptions = useMemo(
    () => [...new Set(preparedRows.map(row => row.ticker))].sort(),
    [preparedRows],
  )

  const filterQuery = tickerFilter.trim()

  const visibleCount = useMemo(() => {
    if (!filterQuery) return preparedRows.length
    return preparedRows.filter(row => matchesTickerFilter(row, filterQuery)).length
  }, [filterQuery, preparedRows])

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
    enabled: preparedRows.length > 0,
    onClosed: handlePositionClosed,
  })

  const enabledBracketCount = useMemo(
    () => countEnabledBrackets(accountEnv, monitoredRows),
    [accountEnv, bracketRevision, monitoredRows],
  )

  const handleClosePosition = useCallback(async (prepared: PreparedRow) => {
    const { row, ticker, storageKey } = prepared
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
      const result = await closeEtoroPosition(row.brokerPositionId!, accountEnv, {
        instrumentId: row.symboltoken,
      })
      logCloseEtoroExchange(ticker, result)
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
  }, [accountEnv, bumpBracketRevision, filterQuery, onPositionClosed])

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
          <div className="pos-ticker-pills" role="list" aria-label="Quick ticker filters">
            {tickerOptions.map(ticker => (
              <button
                key={ticker}
                type="button"
                role="listitem"
                className={`pos-ticker-pill${
                  tickerFilter.trim().toUpperCase() === ticker.toUpperCase() ? ' pos-ticker-pill--active' : ''
                }`}
                onClick={() => setTickerFilter(
                  tickerFilter.trim().toUpperCase() === ticker.toUpperCase() ? '' : ticker,
                )}
              >
                {ticker}
              </button>
            ))}
          </div>
        ) : null}
        <div className="pos-toolbar-spacer" />
        {enabledBracketCount > 0 ? (
          <span className="pos-toolbar-meta pos-toolbar-meta--monitor">
            Monitoring {enabledBracketCount} bracket{enabledBracketCount === 1 ? '' : 's'}
          </span>
        ) : null}
        {refreshedLabel ? (
          <span className="pos-toolbar-meta">Updated {refreshedLabel}</span>
        ) : null}
        <span className="pos-toolbar-meta">
          {filterQuery
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
                    <th>P&amp;L</th>
                    <th>Take profit</th>
                    <th>TP</th>
                    <th>Stop loss</th>
                    <th>SL</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filterQuery && visibleCount === 0 ? (
                    <tr className="pos-filter-empty-row">
                      <td colSpan={9}>
                        <div className="pos-filter-empty">
                          No positions match “{filterQuery}”.
                          <button
                            type="button"
                            className="pos-empty-clear"
                            onClick={() => setTickerFilter('')}
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
                    const hidden = !matchesTickerFilter(prepared, filterQuery)
                    return (
                      <PositionTableRow
                        key={prepared.row.rowKey}
                        prepared={prepared}
                        accountEnv={accountEnv}
                        closing={isClosing}
                        hidden={hidden}
                        onBracketsUpdated={bumpBracketRevision}
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
