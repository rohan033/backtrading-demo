import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Download, RefreshCw, Settings2 } from 'lucide-react'
import './SettingsPage.css'

type TradeStatus = 'open' | 'closed'

type MomentumTrade = {
  id: string
  execution_id: string | null
  order_id: string | null
  source: string
  broker: string
  account_env: string
  symbol: string | null
  tradingsymbol: string | null
  side: string
  quantity: number | null
  capital: number | null
  entry_price: number | null
  exit_price: number | null
  pnl: number | null
  pnl_pct: number | null
  status: TradeStatus
  close_reason: string | null
  opened_at: string
  closed_at: string | null
}

type MomentumSummary = {
  total_trades: number
  open_trades: number
  closed_trades: number
  realized_pnl: number
  wins: number
  losses: number
  win_rate: number | null
}

type TradesResponse = {
  status: boolean
  data: MomentumTrade[]
  summary: MomentumSummary
}

const EMPTY_SUMMARY: MomentumSummary = {
  total_trades: 0,
  open_trades: 0,
  closed_trades: 0,
  realized_pnl: 0,
  wins: 0,
  losses: 0,
  win_rate: null,
}

function formatMoney(value: number | null, broker = 'etoro') {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: broker.toLowerCase() === 'angel' ? 'INR' : 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export default function SettingsPage() {
  const [trades, setTrades] = useState<MomentumTrade[]>([])
  const [summary, setSummary] = useState<MomentumSummary>(EMPTY_SUMMARY)
  const [environmentFilter, setEnvironmentFilter] = useState<'all' | 'live' | 'demo'>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')

  const loadTrades = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/trades-pnl?status=closed&limit=1000')
      if (!response.ok) throw new Error(`Request failed (${response.status})`)
      const payload = (await response.json()) as TradesResponse
      if (!payload.status) throw new Error('The trade ledger could not be loaded')
      const finalized = (payload.data || []).filter(trade =>
        trade.status === 'closed'
        && trade.entry_price != null
        && trade.exit_price != null
        && (trade.pnl != null || trade.pnl_pct != null),
      )
      const wins = finalized.filter(trade => (trade.pnl || 0) > 0).length
      const losses = finalized.filter(trade => (trade.pnl || 0) < 0).length
      setTrades(finalized)
      setSummary({
        total_trades: finalized.length,
        open_trades: 0,
        closed_trades: finalized.length,
        realized_pnl: finalized.reduce((total, trade) => total + (trade.pnl || 0), 0),
        wins,
        losses,
        win_rate: finalized.length ? wins / finalized.length : null,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load order activity')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadTrades()
  }, [loadTrades])

  const visibleTrades = useMemo(
    () => environmentFilter === 'all'
      ? trades
      : trades.filter(trade => trade.account_env.toLowerCase() === environmentFilter),
    [environmentFilter, trades],
  )

  const visibleSummary = useMemo(() => {
    const wins = visibleTrades.filter(trade => (trade.pnl || 0) > 0).length
    const losses = visibleTrades.filter(trade => (trade.pnl || 0) < 0).length
    return {
      ...summary,
      total_trades: visibleTrades.length,
      closed_trades: visibleTrades.length,
      realized_pnl: visibleTrades.reduce((total, trade) => total + (trade.pnl || 0), 0),
      wins,
      losses,
      win_rate: visibleTrades.length ? wins / visibleTrades.length : null,
    }
  }, [summary, visibleTrades])

  const downloadUrl = environmentFilter === 'all'
    ? '/api/trades-pnl/report.csv?status=closed'
    : `/api/trades-pnl/report.csv?status=closed&account_env=${environmentFilter}`

  return (
    <div className="st-root">
      <aside className="st-nav" aria-label="Settings sections">
        <div className="st-nav__heading">
          <Settings2 aria-hidden="true" />
          <div>
            <h1>Settings</h1>
            <p>Workspace controls</p>
          </div>
        </div>
        <button type="button" className="st-nav__item st-nav__item--active" aria-current="page">
          <span className="st-nav__icon"><Activity aria-hidden="true" /></span>
          <span>
            <strong>Order activity</strong>
            <small>Momentum P&amp;L</small>
          </span>
        </button>
        <p className="st-nav__footnote">More workspace settings will appear here.</p>
      </aside>

      <section className="st-content" aria-labelledby="order-activity-title">
        <header className="st-content__header">
          <div>
            <div className="st-eyebrow">Momentum strategy</div>
            <h2 id="order-activity-title">Order activity</h2>
            <p>P&amp;L and execution history for trades opened by Momentum.</p>
          </div>
          <div className="st-header-actions">
            <button
              type="button"
              className="st-button"
              onClick={() => void loadTrades(true)}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? 'st-spin' : ''} aria-hidden="true" />
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
            <a className="st-button st-button--primary" href={downloadUrl}>
              <Download aria-hidden="true" />
              Export CSV
            </a>
          </div>
        </header>

        {error ? (
          <div className="st-error" role="alert">
            <div>
              <strong>Could not load order activity</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void loadTrades()}>Try again</button>
          </div>
        ) : null}

        <div className="st-metrics" aria-label="Momentum trade summary">
          <article className="st-metric st-metric--pnl">
            <span>Realized P&amp;L</span>
            <strong className={visibleSummary.realized_pnl > 0 ? 'st-positive' : visibleSummary.realized_pnl < 0 ? 'st-negative' : ''}>
              {formatMoney(visibleSummary.realized_pnl)}
            </strong>
            <small>Across {visibleSummary.closed_trades} closed trade{visibleSummary.closed_trades === 1 ? '' : 's'}</small>
          </article>
          <article className="st-metric">
            <span>Finalized trades</span>
            <strong>{visibleSummary.closed_trades}</strong>
            <small>Momentum and Positions UI</small>
          </article>
          <article className="st-metric">
            <span>Win rate</span>
            <strong>{visibleSummary.win_rate == null ? '—' : `${(visibleSummary.win_rate * 100).toFixed(1)}%`}</strong>
            <small>{visibleSummary.wins} wins · {visibleSummary.losses} losses</small>
          </article>
          <article className="st-metric">
            <span>Outcomes</span>
            <strong>{visibleSummary.wins} / {visibleSummary.losses}</strong>
            <small>Profitable / losing</small>
          </article>
        </div>

        <div className="st-ledger">
          <div className="st-ledger__toolbar">
            <div>
              <h3>Trade ledger</h3>
              <span>{visibleTrades.length} finalized record{visibleTrades.length === 1 ? '' : 's'}</span>
            </div>
            <div className="st-filter" role="group" aria-label="Filter trades by account environment">
              {(['all', 'live', 'demo'] as const).map(environment => (
                <button
                  type="button"
                  key={environment}
                  className={environmentFilter === environment ? 'st-filter__active' : ''}
                  aria-pressed={environmentFilter === environment}
                  onClick={() => setEnvironmentFilter(environment)}
                >
                  {environment[0].toUpperCase() + environment.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="st-loading" aria-busy="true" aria-label="Loading order activity">
              {Array.from({ length: 4 }).map((_, index) => <span key={index} />)}
            </div>
          ) : visibleTrades.length ? (
            <div className="st-table-wrap">
              <table className="st-table">
                <thead>
                  <tr>
                    <th>Ticker name</th>
                    <th>Source</th>
                    <th className="st-num">Buy</th>
                    <th className="st-num">Sell</th>
                    <th className="st-num">Profit amount</th>
                    <th className="st-num">Profit percent</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTrades.map(trade => (
                    <tr key={trade.id}>
                      <td>
                        <strong className="st-symbol">{trade.tradingsymbol || trade.symbol || 'Unknown'}</strong>
                      </td>
                      <td>
                        <span className={`st-source st-source--${trade.source === 'momentum-trade' ? 'momentum' : 'positions'}`}>
                          {trade.source === 'momentum-trade' ? 'Momentum' : 'Positions page'}
                        </span>
                      </td>
                      <td className="st-num">{formatMoney(trade.entry_price, trade.broker)}</td>
                      <td className="st-num">{formatMoney(trade.exit_price, trade.broker)}</td>
                      <td className={`st-num st-pnl ${trade.pnl != null && trade.pnl > 0 ? 'st-positive' : trade.pnl != null && trade.pnl < 0 ? 'st-negative' : ''}`}>
                        <strong>{formatMoney(trade.pnl, trade.broker)}</strong>
                      </td>
                      <td className={`st-num st-pnl ${trade.pnl_pct != null && trade.pnl_pct > 0 ? 'st-positive' : trade.pnl_pct != null && trade.pnl_pct < 0 ? 'st-negative' : ''}`}>
                        <strong>
                          {trade.pnl_pct == null ? '—' : `${trade.pnl_pct >= 0 ? '+' : ''}${trade.pnl_pct.toFixed(2)}%`}
                        </strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="st-empty">
              <span className="st-empty__icon"><Activity aria-hidden="true" /></span>
              <strong>No finalized {environmentFilter === 'all' ? '' : `${environmentFilter} `}trades yet</strong>
              <p>Completed Momentum trades and closes from the Positions page will appear here.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
