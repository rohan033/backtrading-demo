import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'

import { Button } from '../../components/ui/button'
import { fetchPortfolio, getPortfolioFetchedAt, primePortfolioCache, readCachedPortfolio } from '../../lib/portfolio-cache'
import {
  fetchEtoroOrders,
  fetchEtoroPositions,
  flattenEtoroOrders,
} from '../../lib/etoro-account-data'

const BROKER_TABS = [
  { id: 'angel', label: 'Angel One', accountEnv: 'live', description: 'NSE/BSE holdings via SmartAPI' },
  { id: 'etoro', label: 'eToro', accountEnv: 'demo', description: 'Demo/live positions via eToro API' },
]

import {
  formatBrokerMoney,
  formatIndianDateTime,
  formatIndianNumber,
  formatIndianTime,
  isIndianBroker,
} from '../../lib/currency'

function fmtMoney(value, broker = 'angel') {
  return formatBrokerMoney(broker, value, 2)
}

function fmtPct(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  const prefix = n >= 0 ? '+' : ''
  return `${prefix}${n.toFixed(2)}%`
}

function fmtPnl(value, pct, broker = 'angel') {
  const money = fmtMoney(value, broker)
  const percent = fmtPct(pct)
  if (money === '—' || percent === '—') return money
  return `${money} (${percent})`
}

function fmtLastRefresh(timestamp) {
  if (!timestamp) return null
  const diffSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  const time = formatIndianTime(timestamp)
  if (diffSec < 60) return `Just now · ${time}`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin} min ago · ${time}`
  return formatIndianDateTime(timestamp)
}

function pnlClass(value) {
  if (value > 0) return 'text-green'
  if (value < 0) return 'text-red'
  return 'text-text-primary'
}

function rowMetrics(row) {
  const qty = Number(row.quantity) || 0
  const avg = Number(row.averageprice) || 0
  const ltp = Number(row.ltp) || 0
  const pnl = (ltp - avg) * qty
  const pnlPct = avg > 0 ? ((ltp - avg) / avg) * 100 : 0
  return { qty, avg, ltp, pnl, pnlPct }
}

function getSortValue(row, column) {
  switch (column) {
    case 'tradingsymbol':
      return String(row.tradingsymbol || '').toLowerCase()
    case 'exchange':
      return String(row.exchange || '').toLowerCase()
    case 'quantity':
      return rowMetrics(row).qty
    case 'averageprice':
      return rowMetrics(row).avg
    case 'ltp':
      return rowMetrics(row).ltp
    case 'pnl':
      return rowMetrics(row).pnl
    default:
      return ''
  }
}

function SortHeader({ label, column, sort, onSort, align = 'left' }) {
  const active = sort.column === column
  const alignClass = align === 'right' ? 'text-right' : 'text-left'
  return (
    <th
      className={`px-4 py-3 cursor-pointer select-none transition-colors hover:text-text-primary ${alignClass}`}
      onClick={() => onSort(column)}
    >
      {label}
      {active ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : null}
    </th>
  )
}

export default function PortfolioPage() {
  const [activeBroker, setActiveBroker] = useState('angel')
  const [accountEnv, setAccountEnv] = useState('live')
  const [holdings, setHoldings] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [fromCache, setFromCache] = useState(false)
  const [lastRefreshedAt, setLastRefreshedAt] = useState(null)
  const [sort, setSort] = useState({ column: 'tradingsymbol', direction: 'asc' })
  const [, setClockTick] = useState(0)
  const [etoroOrders, setEtoroOrders] = useState([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState('')
  const [ordersFetchedAt, setOrdersFetchedAt] = useState(null)
  const [positionsLoading, setPositionsLoading] = useState(false)

  const activeTab = BROKER_TABS.find(tab => tab.id === activeBroker) || BROKER_TABS[0]

  const syncLastRefreshedAt = useCallback((broker, env) => {
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
      setError(cached.length ? '' : `No open positions returned for ${activeTab.label} (${accountEnv.toUpperCase()}).`)
    } else {
      setLoading(true)
    }
    setError(prev => (cached ? prev : ''))

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
      if (!(data.data || []).length) {
        setError(`No open positions returned for ${activeTab.label} (${accountEnv.toUpperCase()}).`)
      } else {
        setError('')
      }
    } catch (err) {
      if (!cached) {
        setHoldings([])
        setError(err.message || 'Portfolio request failed')
      }
    } finally {
      setLoading(false)
    }
  }, [activeBroker, accountEnv, activeTab.label, syncLastRefreshedAt])

  const loadEtoroPositions = useCallback(async () => {
    setPositionsLoading(true)
    setError('')
    try {
      const data = await fetchEtoroPositions(accountEnv, { refresh: true })
      if (!data.status) {
        setHoldings([])
        setError(data.message || 'Failed to load eToro positions')
        return
      }
      const rows = data.data || []
      setHoldings(rows)
      setFromCache(Boolean(data.cached))
      primePortfolioCache('etoro', accountEnv, rows)
      syncLastRefreshedAt('etoro', accountEnv)
      if (!rows.length) {
        setError(`No open positions returned for eToro (${accountEnv.toUpperCase()}).`)
      }
    } catch (err) {
      setHoldings([])
      setError(err.message || 'eToro positions request failed')
    } finally {
      setPositionsLoading(false)
      setLoading(false)
    }
  }, [accountEnv, syncLastRefreshedAt])

  const loadEtoroOrders = useCallback(async () => {
    setOrdersLoading(true)
    setOrdersError('')
    try {
      const data = await fetchEtoroOrders(accountEnv)
      if (!data.status) {
        setEtoroOrders([])
        setOrdersError(data.message || 'Failed to load eToro orders')
        return
      }
      const rows = flattenEtoroOrders(data.data)
      setEtoroOrders(rows)
      setOrdersFetchedAt(Date.now())
      if (!rows.length) {
        setOrdersError(`No orders returned for eToro (${accountEnv.toUpperCase()}).`)
      }
    } catch (err) {
      setEtoroOrders([])
      setOrdersError(err.message || 'eToro orders request failed')
    } finally {
      setOrdersLoading(false)
    }
  }, [accountEnv])

  useEffect(() => {
    loadPortfolio()
  }, [loadPortfolio])

  useEffect(() => {
    setEtoroOrders([])
    setOrdersError('')
    setOrdersFetchedAt(null)
  }, [activeBroker, accountEnv])

  useEffect(() => {
    if (activeBroker === 'etoro' && accountEnv === 'live') return
    if (activeBroker === 'angel') setAccountEnv('live')
    if (activeBroker === 'etoro' && accountEnv !== 'demo' && accountEnv !== 'live') setAccountEnv('demo')
  }, [activeBroker, accountEnv])

  useEffect(() => {
    setSort({ column: 'tradingsymbol', direction: 'asc' })
  }, [activeBroker, accountEnv])

  useEffect(() => {
    const intervalId = setInterval(() => setClockTick(tick => tick + 1), 30000)
    return () => clearInterval(intervalId)
  }, [])

  const handleSort = column => {
    setSort(prev => ({
      column,
      direction: prev.column === column && prev.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const sortedHoldings = useMemo(() => {
    if (!holdings.length) return []

    return [...holdings].sort((a, b) => {
      const aVal = getSortValue(a, sort.column)
      const bVal = getSortValue(b, sort.column)

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sort.direction === 'asc' ? aVal - bVal : bVal - aVal
      }

      const aText = String(aVal)
      const bText = String(bVal)
      const cmp = aText.localeCompare(bText, undefined, { numeric: true, sensitivity: 'base' })
      return sort.direction === 'asc' ? cmp : -cmp
    })
  }, [holdings, sort])

  const summary = useMemo(() => {
    let invested = 0
    let marketValue = 0
    for (const row of holdings) {
      const qty = Number(row.quantity) || 0
      const avg = Number(row.averageprice) || 0
      const ltp = Number(row.ltp) || 0
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

  const lastRefreshLabel = fmtLastRefresh(lastRefreshedAt)

  return (
    <div className="h-full overflow-auto p-6">
      <p className="mb-4 max-w-3xl text-sm text-text-secondary">
        Holdings are loaded per broker. Angel One shows your SmartAPI portfolio; eToro shows open positions for the selected Demo/Live environment.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {BROKER_TABS.map(tab => (
          <button
            key={tab.id}
            type="button"
            onClick={() => {
              setActiveBroker(tab.id)
              setAccountEnv(tab.accountEnv)
            }}
            className={`rounded px-3 py-1.5 text-[11px] font-bold transition-colors ${
              activeBroker === tab.id
                ? 'bg-accent text-white'
                : 'bg-card text-text-secondary hover:text-text-primary'
            }`}
          >
            {tab.label}
          </button>
        ))}

        {activeBroker === 'etoro' ? (
          <>
            <select
              value={accountEnv}
              onChange={event => setAccountEnv(event.target.value)}
              className="ml-2 rounded border border-border bg-card px-2 py-1.5 text-[11px] outline-none focus:border-accent"
            >
              <option value="demo">Demo</option>
              <option value="live">Live</option>
            </select>
            <Button
              type="button"
              variant="tertiary"
              size="xs"
              onClick={loadEtoroPositions}
              disabled={positionsLoading || loading}
            >
              {positionsLoading ? 'Fetching positions…' : 'Get open positions'}
            </Button>
            <Button
              type="button"
              variant="tertiary"
              size="xs"
              onClick={loadEtoroOrders}
              disabled={ordersLoading}
            >
              {ordersLoading ? 'Fetching orders…' : 'Get orders'}
            </Button>
          </>
        ) : (
          <span className="ml-2 text-[10px] text-text-secondary uppercase tracking-wide">Live account</span>
        )}

        <div className="ml-auto flex flex-col items-end gap-1">
          <Button
            type="button"
            variant="tertiary"
            size="xs"
            onClick={() => loadPortfolio({ refresh: true })}
            disabled={loading || positionsLoading}
          >
            {loading || positionsLoading ? 'Refreshing…' : 'Refresh'}
          </Button>
          {lastRefreshLabel ? (
            <span className="text-[10px] text-text-secondary">Last refresh · {lastRefreshLabel}</span>
          ) : null}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 text-[10px] text-text-secondary">
        <span>{activeTab.description}</span>
        {activeBroker === 'etoro' ? (
          <span className="rounded bg-card px-2 py-0.5">
            Uses eToro GET /trading/info/{accountEnv === 'demo' ? 'demo' : 'real'}/pnl
          </span>
        ) : null}
        {fromCache ? <span className="rounded bg-card px-2 py-0.5">Cached · avoids broker rate limits</span> : null}
      </div>

      <div className="mb-5 grid gap-3 md:grid-cols-4">
        <div className="rounded border border-border bg-card px-4 py-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary">Positions</div>
          <div className="mt-1 text-lg font-bold">{summary.count}</div>
        </div>
        <div className="rounded border border-border bg-card px-4 py-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary">Invested</div>
          <div className="mt-1 text-lg font-bold">{fmtMoney(summary.invested, activeBroker)}</div>
        </div>
        <div className="rounded border border-border bg-card px-4 py-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary">Market value</div>
          <div className="mt-1 text-lg font-bold">{fmtMoney(summary.marketValue, activeBroker)}</div>
        </div>
        <div className="rounded border border-border bg-card px-4 py-3">
          <div className="text-[9px] uppercase tracking-widest text-text-secondary">Unrealized P&L</div>
          <div className={`mt-1 text-lg font-bold ${pnlClass(summary.pnl)}`}>
            {fmtPnl(summary.pnl, summary.pnlPct, activeBroker)}
          </div>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading {activeTab.label} portfolio…</p>
      ) : null}
      {error ? <p className="mb-4 text-sm text-red">{error}</p> : null}

      {activeBroker === 'etoro' && (ordersLoading || ordersError || etoroOrders.length > 0 || ordersFetchedAt) ? (
        <div className="mb-5 overflow-auto rounded border border-border">
          <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary px-4 py-3">
            <div className="text-[10px] font-bold uppercase tracking-wider text-text-secondary">eToro orders</div>
            {ordersFetchedAt ? (
              <span className="text-[10px] text-text-secondary">
                Last fetch · {fmtLastRefresh(ordersFetchedAt)}
              </span>
            ) : null}
            <span className="text-[10px] text-text-secondary">{etoroOrders.length} rows</span>
          </div>
          {ordersError ? <p className="px-4 py-3 text-sm text-red">{ordersError}</p> : null}
          {!ordersLoading && etoroOrders.length > 0 ? (
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-secondary/70 text-[10px] uppercase tracking-wider text-text-secondary">
                <tr>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Order ID</th>
                  <th className="px-4 py-3">Symbol</th>
                  <th className="px-4 py-3 text-right">Status</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3 text-right">Units</th>
                </tr>
              </thead>
              <tbody>
                {etoroOrders.map((row, index) => (
                  <tr key={`${row.kind}:${row.order_id}:${index}`} className="border-t border-border/70 hover:bg-card/40">
                    <td className="px-4 py-3">{row.kind}</td>
                    <td className="px-4 py-3 font-mono">{row.order_id ?? '—'}</td>
                    <td className="px-4 py-3 font-semibold">{row.symbol || '—'}</td>
                    <td className="px-4 py-3 font-mono text-right">{row.status_id ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-right">{row.amount ?? '—'}</td>
                    <td className="px-4 py-3 font-mono text-right">{row.units ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {ordersLoading ? (
            <p className="px-4 py-3 text-sm text-text-secondary">Loading eToro orders…</p>
          ) : null}
        </div>
      ) : null}

      {!loading && holdings.length > 0 ? (
        <div className="overflow-auto rounded border border-border">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-secondary text-[10px] uppercase tracking-wider text-text-secondary">
              <tr>
                <SortHeader label="Symbol" column="tradingsymbol" sort={sort} onSort={handleSort} />
                <SortHeader label="Exchange" column="exchange" sort={sort} onSort={handleSort} />
                <SortHeader label="Qty" column="quantity" sort={sort} onSort={handleSort} align="right" />
                <SortHeader label="Avg" column="averageprice" sort={sort} onSort={handleSort} align="right" />
                <SortHeader label="LTP" column="ltp" sort={sort} onSort={handleSort} align="right" />
                <SortHeader label="P&L" column="pnl" sort={sort} onSort={handleSort} align="right" />
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {sortedHoldings.map(row => {
                const { qty, avg, ltp, pnl, pnlPct } = rowMetrics(row)
                const rowBroker = row.broker || activeBroker
                const key = `${rowBroker}:${row.symboltoken}:${row.tradingsymbol}`
                return (
                  <tr key={key} className="border-t border-border/70 hover:bg-card/40">
                    <td className="px-4 py-3 font-semibold">{row.tradingsymbol}</td>
                    <td className="px-4 py-3">{row.exchange || '—'}</td>
                    <td className="px-4 py-3 font-mono text-right">
                      {isIndianBroker(rowBroker) ? formatIndianNumber(qty, 0) : qty}
                    </td>
                    <td className="px-4 py-3 font-mono text-right">{fmtMoney(avg, rowBroker)}</td>
                    <td className="px-4 py-3 font-mono text-right">{fmtMoney(ltp, rowBroker)}</td>
                    <td className={`px-4 py-3 font-mono text-right ${pnlClass(pnl)}`}>
                      {fmtPnl(pnl, pnlPct, rowBroker)}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        to="/learn/backtest"
                        state={{ stock: row }}
                        className="text-accent hover:underline"
                      >
                        Backtest
                      </Link>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
