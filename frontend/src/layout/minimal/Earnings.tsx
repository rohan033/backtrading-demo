import { useMemo, useState } from 'react'
import './Earnings.css'
import './ResearchTable.css'
import SymbolLogo from '../../components/SymbolLogo'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import { useWatchlistEarnings } from '../../hooks/useWatchlistEarnings'
import { useWatchlistInsiderTransactions } from '../../hooks/useWatchlistInsiderTransactions'
import {
  buildSymbolVisualMap,
  lookupSymbolVisual,
  type SymbolVisual,
} from '../../lib/symbolVisuals'
import {
  formatCompactMoney,
  formatEarningsHour,
  formatFilingDate,
  coerceInsiderChange,
  formatInsiderSideLabel,
  formatShareCount,
  formatTransactionCode,
  isUpcomingEarnings,
  resolveInsiderSide,
  type InsiderTransaction,
  type WatchlistEarningsEvent,
} from '../../lib/marketResearch'

import {
  compareNumbers,
  compareStrings,
  sortIndicator,
  toggleSortState,
  type SortState,
} from '../../lib/tableSort'

type EarningsSubTab = 'calendar' | 'insider'
type InsiderSideFilter = 'all' | 'buy' | 'sell' | 'neutral'
type InsiderSortKey = 'symbol' | 'insider' | 'side' | 'change' | 'holdings' | 'txnDate' | 'filed' | 'codePrice'
type EarningsSortKey = 'symbol' | 'date' | 'eps' | 'rev' | 'when'

function insiderSymbolLabel(item: InsiderTransaction): string {
  return item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || ''
}

function earningsSymbolLabel(item: WatchlistEarningsEvent): string {
  return item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || ''
}

function earningsEpsValue(item: WatchlistEarningsEvent): number | null {
  if (isUpcomingEarnings(item)) return item.epsEstimate ?? null
  return item.epsActual ?? item.epsEstimate ?? null
}

function earningsRevValue(item: WatchlistEarningsEvent): number | null {
  if (isUpcomingEarnings(item)) return item.revenueEstimate ?? null
  return item.revenueActual ?? item.revenueEstimate ?? null
}

function SortHeader<T extends string>({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string
  sortKey: T
  sort: SortState<T>
  onSort: (key: T) => void
}) {
  const active = sort?.key === sortKey
  return (
    <th className="hm-r-th">
      <button
        type="button"
        className={`hm-r-th-sort${active ? ' hm-r-th-sort--active' : ''}`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span className="hm-r-th-sort__icon" aria-hidden="true">
          {sortIndicator(active, sort?.dir)}
        </span>
      </button>
    </th>
  )
}

function sortInsiderRows(rows: InsiderTransaction[], sort: SortState<InsiderSortKey>): InsiderTransaction[] {
  if (!sort) return rows
  const sideOrder = { buy: 0, neutral: 1, sell: 2 }
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'symbol':
        return compareStrings(insiderSymbolLabel(a), insiderSymbolLabel(b), sort.dir)
      case 'insider':
        return compareStrings(a.name || '', b.name || '', sort.dir)
      case 'side': {
        const av = sideOrder[resolveInsiderSide(a)]
        const bv = sideOrder[resolveInsiderSide(b)]
        return sort.dir === 'asc' ? av - bv : bv - av
      }
      case 'change':
        return compareNumbers(coerceInsiderChange(a.change), coerceInsiderChange(b.change), sort.dir)
      case 'holdings':
        return compareNumbers(a.share, b.share, sort.dir)
      case 'txnDate':
        return compareStrings(a.transactionDate || '', b.transactionDate || '', sort.dir)
      case 'filed':
        return compareStrings(a.filingDate || '', b.filingDate || '', sort.dir)
      case 'codePrice': {
        const priceCmp = compareNumbers(a.transactionPrice, b.transactionPrice, sort.dir)
        if (priceCmp !== 0) return priceCmp
        return compareStrings(a.transactionCode || '', b.transactionCode || '', sort.dir)
      }
      default:
        return 0
    }
  })
}

function sortEarningsRows(rows: WatchlistEarningsEvent[], sort: SortState<EarningsSortKey>): WatchlistEarningsEvent[] {
  if (!sort) return rows
  return [...rows].sort((a, b) => {
    switch (sort.key) {
      case 'symbol':
        return compareStrings(earningsSymbolLabel(a), earningsSymbolLabel(b), sort.dir)
      case 'date':
        return compareStrings(a.date || '', b.date || '', sort.dir)
      case 'eps':
        return compareNumbers(earningsEpsValue(a), earningsEpsValue(b), sort.dir)
      case 'rev':
        return compareNumbers(earningsRevValue(a), earningsRevValue(b), sort.dir)
      case 'when':
        return compareStrings(a.hour || '', b.hour || '', sort.dir)
      default:
        return 0
    }
  })
}

function SymbolCell({
  label,
  sublabel,
  visual,
}: {
  label: string
  sublabel?: string | null
  visual: SymbolVisual | null
}) {
  return (
    <div className="hm-r-sym-cell">
      <span className="hm-r-sym-icon">
        <SymbolLogo symbol={label} visual={visual} />
      </span>
      <div className="hm-r-sym-label">
        <div className="hm-r-val">{label}</div>
        {sublabel ? <div className="hm-r-sub">{sublabel}</div> : null}
      </div>
    </div>
  )
}

function earningsEpsCell(event: WatchlistEarningsEvent) {
  const upcoming = isUpcomingEarnings(event)
  const epsActual = event.epsActual
  const epsEstimate = event.epsEstimate
  const beat = !upcoming && epsActual != null && epsEstimate != null && epsActual >= epsEstimate

  if (upcoming) {
    return (
      <>
        <div className="hm-r-val hm-r-val--pending">
          {epsEstimate != null ? epsEstimate.toFixed(2) : '—'}
        </div>
        <div className="hm-r-sub">consensus est</div>
      </>
    )
  }

  return (
    <>
      <div className={`hm-r-val${beat ? ' hm-r-val--up' : ''}`}>
        {epsActual != null ? epsActual.toFixed(2) : '—'}
      </div>
      <div className="hm-r-sub">
        est {epsEstimate != null ? epsEstimate.toFixed(2) : '—'}
      </div>
    </>
  )
}

function earningsRevenueCell(event: WatchlistEarningsEvent) {
  const upcoming = isUpcomingEarnings(event)
  if (upcoming) {
    return (
      <>
        <div className="hm-r-val hm-r-val--pending">
          {formatCompactMoney(event.revenueEstimate)}
        </div>
        <div className="hm-r-sub">consensus est</div>
      </>
    )
  }

  return (
    <>
      <div className="hm-r-val">{formatCompactMoney(event.revenueActual)}</div>
      <div className="hm-r-sub">
        est {formatCompactMoney(event.revenueEstimate)}
      </div>
    </>
  )
}

function EarningsTable({
  rows,
  symbolVisuals,
}: {
  rows: WatchlistEarningsEvent[]
  symbolVisuals: Map<string, SymbolVisual>
}) {
  const [sort, setSort] = useState<SortState<EarningsSortKey>>(null)
  const sortedRows = useMemo(() => sortEarningsRows(rows, sort), [rows, sort])

  if (!rows.length) {
    return <p className="er-empty">No events in this section.</p>
  }

  const handleSort = (key: EarningsSortKey) => {
    setSort(prev => toggleSortState(prev, key))
  }

  return (
    <div className="hm-r-table-scroll">
      <div className="hm-r-table-card">
        <table className="hm-r-table">
          <colgroup>
            <col style={{ width: '18%' }} />
            <col style={{ width: '16%' }} />
            <col className="hm-r-col-eps" />
            <col className="hm-r-col-rev" />
            <col className="hm-r-col-when" />
          </colgroup>
          <thead>
            <tr className="hm-r-thead-row">
              <SortHeader label="Symbol" sortKey="symbol" sort={sort} onSort={handleSort} />
              <SortHeader label="Date" sortKey="date" sort={sort} onSort={handleSort} />
              <SortHeader label="EPS" sortKey="eps" sort={sort} onSort={handleSort} />
              <SortHeader label="Rev" sortKey="rev" sort={sort} onSort={handleSort} />
              <SortHeader label="When" sortKey="when" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(item => {
              const key = `${item.symbol}-${item.date}-${item.quarter}-${item.year}-${item.hour}`
              const label = item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || '—'
              const visual = lookupSymbolVisual(symbolVisuals, label)
              return (
                <tr key={key} className="hm-r-table-row">
                  <td className="hm-r-td">
                    <SymbolCell
                      label={label}
                      sublabel={item.symbol && item.symbol !== label ? item.symbol : null}
                      visual={visual}
                    />
                  </td>
                  <td className="hm-r-td">
                    <div className="hm-r-val">{item.date || '—'}</div>
                    <div className="hm-r-sub">
                      {item.quarter ? `Q${item.quarter}` : '—'}
                      {item.year ? ` ${item.year}` : ''}
                    </div>
                  </td>
                  <td className="hm-r-td">{earningsEpsCell(item)}</td>
                  <td className="hm-r-td">{earningsRevenueCell(item)}</td>
                  <td className="hm-r-td">{formatEarningsHour(item.hour)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function filterInsiderRows(
  rows: InsiderTransaction[],
  sideFilter: InsiderSideFilter,
): InsiderTransaction[] {
  if (sideFilter === 'all') return rows
  return rows.filter(row => resolveInsiderSide(row) === sideFilter)
}

function InsiderTable({
  rows,
  symbolVisuals,
}: {
  rows: InsiderTransaction[]
  symbolVisuals: Map<string, SymbolVisual>
}) {
  const [sort, setSort] = useState<SortState<InsiderSortKey>>({ key: 'txnDate', dir: 'desc' })
  const sortedRows = useMemo(() => sortInsiderRows(rows, sort), [rows, sort])

  if (!rows.length) {
    return <p className="er-empty">No insider transactions found for the selected filter.</p>
  }

  const handleSort = (key: InsiderSortKey) => {
    setSort(prev => toggleSortState(prev, key))
  }

  return (
    <div className="hm-r-table-scroll">
      <div className="hm-r-table-card">
        <table className="hm-r-table">
          <colgroup>
            <col style={{ width: '14%' }} />
            <col style={{ width: '18%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '10%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} />
            <col style={{ width: '17%' }} />
          </colgroup>
          <thead>
            <tr className="hm-r-thead-row">
              <SortHeader label="Symbol" sortKey="symbol" sort={sort} onSort={handleSort} />
              <SortHeader label="Insider" sortKey="insider" sort={sort} onSort={handleSort} />
              <SortHeader label="Side" sortKey="side" sort={sort} onSort={handleSort} />
              <SortHeader label="Change" sortKey="change" sort={sort} onSort={handleSort} />
              <SortHeader label="Holdings" sortKey="holdings" sort={sort} onSort={handleSort} />
              <SortHeader label="Txn date" sortKey="txnDate" sort={sort} onSort={handleSort} />
              <SortHeader label="Filed" sortKey="filed" sort={sort} onSort={handleSort} />
              <SortHeader label="Code / price" sortKey="codePrice" sort={sort} onSort={handleSort} />
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(item => {
              const key = item.id || `${item.symbol}-${item.name}-${item.transactionDate}-${item.change}`
              const label = item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || '—'
              const visual = lookupSymbolVisual(symbolVisuals, label)
              const side = resolveInsiderSide(item)
              return (
                <tr key={key} className="hm-r-table-row">
                  <td className="hm-r-td">
                    <SymbolCell label={label} visual={visual} />
                  </td>
                  <td className="hm-r-td">
                    <div className="hm-r-val">{item.name || '—'}</div>
                  </td>
                  <td className="hm-r-td">
                    <span className={`hm-r-side hm-r-side--${side}`}>
                      {formatInsiderSideLabel(item)}
                    </span>
                  </td>
                  <td className="hm-r-td">
                    <span className={`hm-r-val${side === 'buy' ? ' hm-r-val--up' : side === 'sell' ? ' hm-r-val--down' : ''}`}>
                      {(() => {
                        const change = coerceInsiderChange(item.change)
                        return (
                          <>
                            {change != null && change > 0 ? '+' : ''}
                            {formatShareCount(change)}
                          </>
                        )
                      })()}
                    </span>
                  </td>
                  <td className="hm-r-td">{formatShareCount(item.share)}</td>
                  <td className="hm-r-td">{formatFilingDate(item.transactionDate)}</td>
                  <td className="hm-r-td">{formatFilingDate(item.filingDate)}</td>
                  <td className="hm-r-td">
                    <div className="hm-r-sub">{formatTransactionCode(item.transactionCode)}</div>
                    <div className="hm-r-val">{formatCompactMoney(item.transactionPrice)}</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

type EarningsProps = {
  events?: WatchlistEarningsEvent[]
  loading?: boolean
  error?: string
  onRefresh?: (force?: boolean) => void
}

export default function Earnings({
  events: externalEvents,
  loading: externalLoading,
  error: externalError,
  onRefresh,
}: EarningsProps) {
  const [subTab, setSubTab] = useState<EarningsSubTab>('calendar')
  const [symbolFilter, setSymbolFilter] = useState('')
  const [sideFilter, setSideFilter] = useState<InsiderSideFilter>('all')
  const { watchlists } = useWatchlistStream()
  const symbolVisuals = useMemo(() => buildSymbolVisualMap(watchlists), [watchlists])

  const internal = useWatchlistEarnings({ enabled: externalEvents == null && subTab === 'calendar' })
  const events = externalEvents ?? internal.events
  const loading = externalLoading ?? internal.loading
  const error = externalError ?? internal.error
  const refresh = onRefresh ?? internal.refresh

  const insider = useWatchlistInsiderTransactions({
    enabled: subTab === 'insider',
    symbol: symbolFilter,
  })

  const { upcoming, reported } = useMemo(() => {
    const next: WatchlistEarningsEvent[] = []
    const past: WatchlistEarningsEvent[] = []
    for (const item of events) {
      if (isUpcomingEarnings(item)) next.push(item)
      else past.push(item)
    }
    next.sort((a, b) => String(a.date).localeCompare(String(b.date)))
    past.sort((a, b) => String(b.date).localeCompare(String(a.date)))
    return { upcoming: next, reported: past }
  }, [events])

  const symbolFilteredInsiderRows = useMemo(() => {
    if (!symbolFilter.trim()) return insider.transactions
    const query = symbolFilter.trim().toLowerCase()
    return insider.transactions.filter(row => {
      const label = insiderSymbolLabel(row)
      return label.toLowerCase().includes(query)
        || String(row.symbol || '').toLowerCase().includes(query)
    })
  }, [insider.transactions, symbolFilter])

  const filteredInsiderRows = useMemo(
    () => filterInsiderRows(symbolFilteredInsiderRows, sideFilter),
    [symbolFilteredInsiderRows, sideFilter],
  )

  const symbolOptions = useMemo(() => {
    const set = new Set<string>()
    if (subTab === 'calendar') {
      for (const item of events) {
        const label = item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol
        if (label) set.add(label)
      }
    } else {
      for (const label of insider.symbols) set.add(label)
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [subTab, events, insider.symbols])

  const calendarFilteredUpcoming = useMemo(() => {
    if (!symbolFilter.trim()) return upcoming
    const query = symbolFilter.trim().toLowerCase()
    return upcoming.filter(item => {
      const label = item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || ''
      return label.toLowerCase().includes(query) || String(item.symbol || '').toLowerCase().includes(query)
    })
  }, [upcoming, symbolFilter])

  const calendarFilteredReported = useMemo(() => {
    if (!symbolFilter.trim()) return reported
    const query = symbolFilter.trim().toLowerCase()
    return reported.filter(item => {
      const label = item.watchlistRefs?.[0]?.tradingsymbol || item.symbol || item.finnhubSymbol || ''
      return label.toLowerCase().includes(query) || String(item.symbol || '').toLowerCase().includes(query)
    })
  }, [reported, symbolFilter])

  const activeLoading = subTab === 'calendar' ? loading : insider.loading
  const activeError = subTab === 'calendar' ? error : insider.error

  return (
    <div className="er-root">
      <div className="er-toolbar">
        <span className="er-toolbar-title">Watchlist research</span>
        <div className="er-subtabs">
          <button
            type="button"
            className={`er-subtab${subTab === 'calendar' ? ' er-subtab--active' : ''}`}
            onClick={() => setSubTab('calendar')}
          >
            Earnings
          </button>
          <button
            type="button"
            className={`er-subtab${subTab === 'insider' ? ' er-subtab--active' : ''}`}
            onClick={() => setSubTab('insider')}
          >
            Insider
          </button>
        </div>
        <label className="er-filter">
          <span>Symbol</span>
          <select
            value={symbolFilter}
            onChange={event => setSymbolFilter(event.target.value)}
          >
            <option value="">All watchlist</option>
            {symbolOptions.map(symbol => (
              <option key={symbol} value={symbol}>{symbol}</option>
            ))}
          </select>
        </label>
        {subTab === 'insider' ? (
          <div className="er-side-filters" role="group" aria-label="Trade side filter">
            {([
              ['all', 'All'],
              ['buy', 'Buy'],
              ['sell', 'Sell'],
              ['neutral', 'Neutral'],
            ] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`er-side-filter er-side-filter--${id}${sideFilter === id ? ' er-side-filter--active' : ''}`}
                onClick={() => setSideFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="er-toolbar-meta">
          {subTab === 'calendar'
            ? `${calendarFilteredUpcoming.length + calendarFilteredReported.length} events`
            : `${filteredInsiderRows.length} trades`}
        </span>
        <span className="er-toolbar-spacer" />
        <button
          type="button"
          className="er-toolbar-btn"
          onClick={() => {
            if (subTab === 'calendar') void refresh(true)
            else void insider.refresh(true)
          }}
        >
          Refresh
        </button>
      </div>

      <div className="er-body">
        {activeLoading ? (
          <p className="er-empty">
            {subTab === 'calendar' ? 'Loading earnings for watchlist symbols…' : 'Loading insider transactions…'}
          </p>
        ) : null}
        {!activeLoading && activeError ? <p className="er-empty er-empty--error">{activeError}</p> : null}

        {!activeLoading && !activeError && subTab === 'calendar' ? (
          <>
            {!calendarFilteredUpcoming.length && !calendarFilteredReported.length ? (
              <p className="er-empty">
                No earnings dates found for watchlist symbols. Add US-listed tickers to a watchlist.
              </p>
            ) : null}
            {calendarFilteredUpcoming.length ? (
              <section className="hm-r-section">
                <h2 className="hm-r-section__title">Upcoming</h2>
                <EarningsTable rows={calendarFilteredUpcoming} symbolVisuals={symbolVisuals} />
              </section>
            ) : null}
            {calendarFilteredReported.length ? (
              <section className="hm-r-section">
                <h2 className="hm-r-section__title">Reported</h2>
                <EarningsTable rows={calendarFilteredReported} symbolVisuals={symbolVisuals} />
              </section>
            ) : null}
          </>
        ) : null}

        {!activeLoading && !activeError && subTab === 'insider' ? (
          <>
            {insider.lastPolledAt ? (
              <p className="er-poll-note">
                Background poller last synced {new Date(insider.lastPolledAt).toLocaleString()}.
              </p>
            ) : null}
            {!filteredInsiderRows.length ? (
              <p className="er-empty">
                {sideFilter !== 'all' || symbolFilter
                  ? 'No insider trades match the current filters.'
                  : 'No insider trades cached yet. The background poller fills this table from Form 3/4/5 filings.'}
              </p>
            ) : (
              <InsiderTable
                rows={filteredInsiderRows}
                symbolVisuals={symbolVisuals}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  )
}
