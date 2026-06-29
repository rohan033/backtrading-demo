import { useCallback, useEffect, useMemo, useState } from 'react'
import './Portfolio.css'
import './ResearchTable.css'
import SymbolLogo from '../../components/SymbolLogo'
import { useWatchlistStream } from '../../context/WatchlistStreamContext'
import {
  fetchPortfolio,
  getPortfolioFetchedAt,
  readCachedPortfolio,
  type PortfolioRow,
} from '../../lib/portfolio-cache'
import {
  buildPortfolioSymbolIndex,
  buildPortfolioVisualMap,
  hydratePortfolioSymbolMetadata,
  resolvePortfolioSymbolDisplay,
  type InstrumentDisplayRecord,
} from '../../lib/portfolioSymbolDisplay'
import type { SymbolVisual } from '../../lib/symbolVisuals'
import {
  formatBrokerMoney,
  formatIndianNumber,
  isIndianBroker,
} from '../../lib/currency'
import {
  compareNumbers,
  compareStrings,
  sortIndicator,
  toggleSortState,
  type SortState,
} from '../../lib/tableSort'

const HIDE_SENSITIVE_KEY = 'minimal-portfolio-hide-sensitive'
const MASK = '•••••'

const BROKER_TABS = [
  { id: 'angel', label: 'Angel One', accountEnv: 'live' },
  { id: 'etoro', label: 'eToro', accountEnv: 'demo' },
] as const

type BrokerId = (typeof BROKER_TABS)[number]['id']
type SortKey = 'tradingsymbol' | 'exchange' | 'quantity' | 'averageprice' | 'ltp' | 'pnl'

function loadHideSensitive(): boolean {
  try {
    return localStorage.getItem(HIDE_SENSITIVE_KEY) === '1'
  } catch {
    return false
  }
}

function rowMetrics(row: PortfolioRow) {
  const qty = Number(row.quantity) || 0
  const avg = Number(row.averageprice) || 0
  const ltp = Number(row.ltp) || 0
  const pnl = (ltp - avg) * qty
  const pnlPct = avg > 0 ? ((ltp - avg) / avg) * 100 : 0
  return { qty, avg, ltp, pnl, pnlPct }
}

function fmtPct(value: number) {
  if (!Number.isFinite(value)) return '—'
  const prefix = value >= 0 ? '+' : ''
  return `${prefix}${value.toFixed(2)}%`
}

function fmtPnl(value: number, pct: number, broker: string) {
  const money = formatBrokerMoney(broker, value, 2)
  const percent = fmtPct(pct)
  if (money === '—' || percent === '—') return money
  return `${money} (${percent})`
}

function mask(display: string, hidden: boolean) {
  return hidden ? MASK : display
}

function SymbolCell({
  ticker,
  name,
  visual,
}: {
  ticker: string
  name: string | null
  visual: SymbolVisual | null
}) {
  return (
    <div className="hm-r-sym-cell">
      <span className="hm-r-sym-icon">
        <SymbolLogo symbol={ticker} visual={visual} />
      </span>
      <div className="hm-r-sym-label">
        <div className="hm-r-val">{ticker}</div>
        {name ? <div className="hm-r-sub">{name}</div> : null}
      </div>
    </div>
  )
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string
  sortKey: SortKey
  sort: SortState<SortKey>
  onSort: (key: SortKey) => void
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

function EyeToggle({
  hidden,
  onToggle,
}: {
  hidden: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      className={`pf-eye-btn${hidden ? ' pf-eye-btn--active' : ''}`}
      onClick={onToggle}
      aria-pressed={hidden}
      aria-label={hidden ? 'Show financial details' : 'Hide financial details'}
      title={hidden ? 'Show financial details' : 'Hide financial details'}
    >
      {hidden ? (
        <svg className="pf-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
          <path d="M1 1l22 22" />
          <path d="M14.12 14.12a3 3 0 0 1-4.24-4.24" />
        </svg>
      ) : (
        <svg className="pf-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  )
}

export default function Portfolio() {
  const { watchlists } = useWatchlistStream()
  const [activeBroker, setActiveBroker] = useState<BrokerId>('etoro')
  const [accountEnv, setAccountEnv] = useState('demo')
  const [holdings, setHoldings] = useState<PortfolioRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fromCache, setFromCache] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null)
  const [sort, setSort] = useState<SortState<SortKey>>({ key: 'tradingsymbol', dir: 'asc' })
  const [hideSensitive, setHideSensitive] = useState(loadHideSensitive)
  const [instrumentMetadata, setInstrumentMetadata] = useState<Map<string, InstrumentDisplayRecord>>(new Map())

  const watchlistIndex = useMemo(
    () => buildPortfolioSymbolIndex(watchlists, activeBroker, accountEnv),
    [watchlists, activeBroker, accountEnv],
  )
  const visualMap = useMemo(() => buildPortfolioVisualMap(watchlists), [watchlists])

  const activeTab = BROKER_TABS.find(tab => tab.id === activeBroker) || BROKER_TABS[0]

  const syncLastRefreshedAt = useCallback((broker: string, env: string) => {
    const fetchedAt = getPortfolioFetchedAt(broker, env)
    if (fetchedAt) setLastRefreshedAt(fetchedAt)
  }, [])

  const loadPortfolio = useCallback(async ({ refresh = false } = {}) => {
    const cached = !refresh ? readCachedPortfolio(activeBroker, accountEnv) : null
    if (cached) {
      setHoldings(cached)
      setFromCache(true)
      setLoading(false)
      syncLastRefreshedAt(activeBroker, accountEnv)
      setError(cached.length ? '' : `No open positions for ${activeTab.label} (${accountEnv.toUpperCase()}).`)
    } else {
      setLoading(true)
    }

    try {
      const data = await fetchPortfolio(activeBroker, accountEnv, { refresh })
      if (!data.status) {
        if (!cached) {
          setHoldings([])
          setError(data.message || `Failed to load ${activeTab.label} portfolio`)
        }
        return
      }
      setHoldings(data.data || [])
      setFromCache(Boolean(data.cached))
      syncLastRefreshedAt(activeBroker, accountEnv)
      const rows = data.data || []
      if (activeBroker === 'etoro' && rows.length) {
        const metadata = await hydratePortfolioSymbolMetadata(
          activeBroker,
          accountEnv,
          rows,
          buildPortfolioSymbolIndex(watchlists, activeBroker, accountEnv),
        )
        if (metadata.size) setInstrumentMetadata(metadata)
      }
      if (!rows.length) {
        setError(`No open positions for ${activeTab.label} (${accountEnv.toUpperCase()}).`)
      } else {
        setError('')
      }
    } catch (err) {
      if (!cached) {
        setHoldings([])
        setError(err instanceof Error ? err.message : 'Portfolio request failed')
      }
    } finally {
      setLoading(false)
    }
  }, [activeBroker, accountEnv, activeTab.label, syncLastRefreshedAt, watchlists])

  useEffect(() => {
    loadPortfolio()
  }, [loadPortfolio])

  useEffect(() => {
    if (activeBroker === 'angel') setAccountEnv('live')
    if (activeBroker === 'etoro' && accountEnv !== 'demo' && accountEnv !== 'live') {
      setAccountEnv('demo')
    }
  }, [activeBroker, accountEnv])

  useEffect(() => {
    setSort({ key: 'tradingsymbol', dir: 'asc' })
    setInstrumentMetadata(new Map())
  }, [activeBroker, accountEnv])

  useEffect(() => {
    if (activeBroker !== 'etoro' || !holdings.length) return

    let cancelled = false
    void hydratePortfolioSymbolMetadata(
      activeBroker,
      accountEnv,
      holdings,
      watchlistIndex,
    ).then(metadata => {
      if (cancelled || !metadata.size) return
      setInstrumentMetadata(prev => {
        if (prev.size === metadata.size) {
          let same = true
          for (const [key, value] of metadata.entries()) {
            if (prev.get(key) !== value) {
              same = false
              break
            }
          }
          if (same) return prev
        }
        return metadata
      })
    })

    return () => {
      cancelled = true
    }
  }, [holdings, watchlistIndex, activeBroker, accountEnv])

  useEffect(() => {
    try {
      localStorage.setItem(HIDE_SENSITIVE_KEY, hideSensitive ? '1' : '0')
    } catch {
      // ignore
    }
  }, [hideSensitive])

  const sortedHoldings = useMemo(() => {
    if (!sort) return holdings
    return [...holdings].sort((a, b) => {
      switch (sort.key) {
        case 'tradingsymbol':
          return compareStrings(String(a.tradingsymbol || ''), String(b.tradingsymbol || ''), sort.dir)
        case 'exchange':
          return compareStrings(String(a.exchange || ''), String(b.exchange || ''), sort.dir)
        case 'quantity':
          return compareNumbers(rowMetrics(a).qty, rowMetrics(b).qty, sort.dir)
        case 'averageprice':
          return compareNumbers(rowMetrics(a).avg, rowMetrics(b).avg, sort.dir)
        case 'ltp':
          return compareNumbers(rowMetrics(a).ltp, rowMetrics(b).ltp, sort.dir)
        case 'pnl':
          return compareNumbers(rowMetrics(a).pnl, rowMetrics(b).pnl, sort.dir)
        default:
          return 0
      }
    })
  }, [holdings, sort])

  const summary = useMemo(() => {
    let invested = 0
    let marketValue = 0
    for (const row of holdings) {
      const { qty, avg, ltp } = rowMetrics(row)
      invested += qty * avg
      marketValue += qty * ltp
    }
    return {
      count: holdings.length,
      invested,
      marketValue,
      pnl: marketValue - invested,
      pnlPct: invested > 0 ? ((marketValue - invested) / invested) * 100 : 0,
    }
  }, [holdings])

  const lastRefreshLabel = lastRefreshedAt
    ? new Date(lastRefreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="pf-root">
      <div className="pf-toolbar">
        <div className="pf-subtabs">
          <button type="button" className="pf-subtab pf-subtab--active">
            Holdings
          </button>
        </div>

        <div className="pf-broker-tabs" role="group" aria-label="Broker">
          {BROKER_TABS.map(tab => (
            <button
              key={tab.id}
              type="button"
              className={`pf-broker-tab${activeBroker === tab.id ? ' pf-broker-tab--active' : ''}`}
              onClick={() => {
                setActiveBroker(tab.id)
                setAccountEnv(tab.accountEnv)
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeBroker === 'etoro' ? (
          <select
            className="pf-env-select"
            value={accountEnv}
            onChange={event => setAccountEnv(event.target.value)}
            aria-label="eToro account environment"
          >
            <option value="demo">Demo</option>
            <option value="live">Live</option>
          </select>
        ) : (
          <span className="pf-toolbar-meta">Live account</span>
        )}

        <span className="pf-toolbar-spacer" />

        {fromCache ? <span className="pf-toolbar-meta">Cached</span> : null}
        {lastRefreshLabel ? (
          <span className="pf-toolbar-meta">Updated {lastRefreshLabel}</span>
        ) : null}

        <EyeToggle
          hidden={hideSensitive}
          onToggle={() => setHideSensitive(value => !value)}
        />

        <button
          type="button"
          className="pf-btn"
          onClick={() => loadPortfolio({ refresh: true })}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="pf-body">
        <div className="pf-summary">
          <div className="pf-summary-card">
            <div className="pf-summary-label">Positions</div>
            <div className="pf-summary-value">{summary.count}</div>
          </div>
          <div className="pf-summary-card">
            <div className="pf-summary-label">Invested</div>
            <div className="pf-summary-value">
              {mask(formatBrokerMoney(activeBroker, summary.invested, 2), hideSensitive)}
            </div>
          </div>
          <div className="pf-summary-card">
            <div className="pf-summary-label">Market value</div>
            <div className="pf-summary-value">
              {mask(formatBrokerMoney(activeBroker, summary.marketValue, 2), hideSensitive)}
            </div>
          </div>
          <div className="pf-summary-card">
            <div className="pf-summary-label">Unrealized P&amp;L</div>
            <div
              className={`pf-summary-value${
                hideSensitive ? '' : summary.pnl > 0 ? ' pf-summary-value--up' : summary.pnl < 0 ? ' pf-summary-value--down' : ''
              }`}
            >
              {mask(fmtPnl(summary.pnl, summary.pnlPct, activeBroker), hideSensitive)}
            </div>
          </div>
        </div>

        {loading ? <p className="pf-status">Loading {activeTab.label} portfolio…</p> : null}
        {error ? <p className="pf-status pf-status--error">{error}</p> : null}

        {!loading && holdings.length > 0 ? (
          <div className="hm-r-table-scroll">
            <div className="hm-r-table-card">
              <table className="hm-r-table">
                <colgroup>
                  <col />
                  <col />
                  <col className="pf-col-qty" />
                  <col className="pf-col-avg" />
                  <col className="pf-col-ltp" />
                  <col className="pf-col-pnl" />
                </colgroup>
                <thead>
                  <tr className="hm-r-thead-row">
                    <SortHeader label="Symbol" sortKey="tradingsymbol" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                    <SortHeader label="Exchange" sortKey="exchange" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                    <SortHeader label="Qty" sortKey="quantity" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                    <SortHeader label="Avg" sortKey="averageprice" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                    <SortHeader label="LTP" sortKey="ltp" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                    <SortHeader label="P&L" sortKey="pnl" sort={sort} onSort={key => setSort(prev => toggleSortState(prev, key))} />
                  </tr>
                </thead>
                <tbody>
                  {sortedHoldings.map(row => {
                    const { qty, avg, ltp, pnl, pnlPct } = rowMetrics(row)
                    const rowBroker = String(row.broker || activeBroker)
                    const display = resolvePortfolioSymbolDisplay(
                      row,
                      watchlistIndex,
                      visualMap,
                      instrumentMetadata,
                    )
                    const qtyLabel = isIndianBroker(rowBroker)
                      ? formatIndianNumber(qty, 0)
                      : String(qty)
                    const key = `${rowBroker}:${row.symboltoken}:${row.tradingsymbol}`
                    return (
                      <tr key={key} className="hm-r-table-row">
                        <td className="hm-r-td">
                          <SymbolCell
                            ticker={display.ticker}
                            name={display.name}
                            visual={display.visual}
                          />
                        </td>
                        <td className="hm-r-td">{String(row.exchange || '—')}</td>
                        <td className="hm-r-td pf-td-num">{mask(qtyLabel, hideSensitive)}</td>
                        <td className="hm-r-td pf-td-num">{mask(formatBrokerMoney(rowBroker, avg, 2), hideSensitive)}</td>
                        <td className="hm-r-td pf-td-num">{mask(formatBrokerMoney(rowBroker, ltp, 2), hideSensitive)}</td>
                        <td
                          className={`hm-r-td pf-td-num${
                            hideSensitive ? '' : pnl > 0 ? ' pf-td-pnl--up' : pnl < 0 ? ' pf-td-pnl--down' : ''
                          }`}
                        >
                          {mask(fmtPnl(pnl, pnlPct, rowBroker), hideSensitive)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
