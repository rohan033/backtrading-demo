import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, Download, RefreshCw, Settings2 } from 'lucide-react'
import './SettingsPage.css'

type TradeStatus = 'open' | 'closed'

type MomentumTrade = {
  id: string
  execution_id: string | null
  order_id: string | null
  session_id?: string | null
  attempt_id?: string | null
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

type LedgerRow =
  | { kind: 'trade'; trade: MomentumTrade }
  | {
      kind: 'session'
      sessionId: string
      trades: MomentumTrade[]
      pnl: number
      accountEnv: string
      broker: string
      symbols: string[]
    }

function shortSessionId(sessionId: string): string {
  const clean = sessionId.trim()
  if (clean.length <= 12) return clean
  return `${clean.slice(0, 8)}…${clean.slice(-4)}`
}

function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function buildLedgerRows(trades: MomentumTrade[]): LedgerRow[] {
  const rows: LedgerRow[] = []
  const sessionBuckets = new Map<string, MomentumTrade[]>()
  const sessionOrder: string[] = []

  for (const trade of trades) {
    if (trade.source === '1pc_session' && trade.session_id) {
      const key = trade.session_id
      if (!sessionBuckets.has(key)) {
        sessionBuckets.set(key, [])
        sessionOrder.push(key)
      }
      sessionBuckets.get(key)!.push(trade)
      continue
    }
    rows.push({ kind: 'trade', trade })
  }

  for (const sessionId of sessionOrder) {
    const sessionTrades = sessionBuckets.get(sessionId) || []
    const symbols = Array.from(
      new Set(
        sessionTrades
          .map(trade => trade.tradingsymbol || trade.symbol || '')
          .filter(Boolean),
      ),
    )
    rows.push({
      kind: 'session',
      sessionId,
      trades: sessionTrades,
      pnl: sessionTrades.reduce((total, trade) => total + (trade.pnl || 0), 0),
      accountEnv: sessionTrades[0]?.account_env || 'demo',
      broker: sessionTrades[0]?.broker || 'etoro',
      symbols,
    })
  }

  return rows
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

  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({})

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

  const ledgerRows = useMemo(() => buildLedgerRows(visibleTrades), [visibleTrades])

  const toggleSession = useCallback((sessionId: string) => {
    setExpandedSessions(prev => ({ ...prev, [sessionId]: !prev[sessionId] }))
  }, [])

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
    <div className="set-root">
      <aside className="set-nav" aria-label="Settings sections">
        <div className="set-nav__heading">
          <Settings2 aria-hidden="true" />
          <div>
            <h1>Settings</h1>
            <p>Workspace controls</p>
          </div>
        </div>
        <button type="button" className="set-nav__item set-nav__item--active" aria-current="page">
          <span className="set-nav__icon"><Activity aria-hidden="true" /></span>
          <span>
            <strong>Order activity</strong>
            <small>Momentum P&amp;L</small>
          </span>
        </button>
        <p className="set-nav__footnote">More workspace settings will appear here.</p>
      </aside>

      <section className="set-content" aria-labelledby="order-activity-title">
        <header className="set-content__header">
          <div>
            <div className="set-eyebrow">Momentum strategy</div>
            <h2 id="order-activity-title">Order activity</h2>
            <p>P&amp;L and execution history for trades opened by Momentum.</p>
          </div>
          <div className="set-header-actions">
            <button
              type="button"
              className="set-button"
              onClick={() => void loadTrades(true)}
              disabled={refreshing}
            >
              <RefreshCw className={refreshing ? 'set-spin' : ''} aria-hidden="true" />
              {refreshing ? 'Refreshing' : 'Refresh'}
            </button>
            <a className="set-button set-button--primary" href={downloadUrl}>
              <Download aria-hidden="true" />
              Export CSV
            </a>
          </div>
        </header>

        {error ? (
          <div className="set-error" role="alert">
            <div>
              <strong>Could not load order activity</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void loadTrades()}>Try again</button>
          </div>
        ) : null}

        <div className="set-metrics" aria-label="Momentum trade summary">
          <article className="set-metric set-metric--pnl">
            <span>Realized P&amp;L</span>
            <strong className={visibleSummary.realized_pnl > 0 ? 'set-positive' : visibleSummary.realized_pnl < 0 ? 'set-negative' : ''}>
              {formatMoney(visibleSummary.realized_pnl)}
            </strong>
            <small>Across {visibleSummary.closed_trades} closed trade{visibleSummary.closed_trades === 1 ? '' : 's'}</small>
          </article>
          <article className="set-metric">
            <span>Finalized trades</span>
            <strong>{visibleSummary.closed_trades}</strong>
            <small>Momentum and Positions UI</small>
          </article>
          <article className="set-metric">
            <span>Win rate</span>
            <strong>{visibleSummary.win_rate == null ? '—' : `${(visibleSummary.win_rate * 100).toFixed(1)}%`}</strong>
            <small>{visibleSummary.wins} wins · {visibleSummary.losses} losses</small>
          </article>
          <article className="set-metric">
            <span>Outcomes</span>
            <strong>{visibleSummary.wins} / {visibleSummary.losses}</strong>
            <small>Profitable / losing</small>
          </article>
        </div>

        <div className="set-ledger">
          <div className="set-ledger__toolbar">
            <div>
              <h3>Trade ledger</h3>
              <span>{visibleTrades.length} finalized record{visibleTrades.length === 1 ? '' : 's'}</span>
            </div>
            <div className="set-filter" role="group" aria-label="Filter trades by account environment">
              {(['all', 'live', 'demo'] as const).map(environment => (
                <button
                  type="button"
                  key={environment}
                  className={environmentFilter === environment ? 'set-filter__active' : ''}
                  aria-pressed={environmentFilter === environment}
                  onClick={() => setEnvironmentFilter(environment)}
                >
                  {environment[0].toUpperCase() + environment.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="set-loading" aria-busy="true" aria-label="Loading order activity">
              {Array.from({ length: 4 }).map((_, index) => <span key={index} />)}
            </div>
          ) : visibleTrades.length ? (
            <div className="set-table-wrap">
              <table className="set-table">
                <thead>
                  <tr>
                    <th>Ticker name</th>
                    <th>Source</th>
                    <th className="set-num">Buy</th>
                    <th className="set-num">Sell</th>
                    <th className="set-num">Profit amount</th>
                    <th className="set-num">Profit percent</th>
                  </tr>
                </thead>
                <tbody>
                  {ledgerRows.map(row => {
                    if (row.kind === 'trade') {
                      const trade = row.trade
                      return (
                        <tr key={trade.id}>
                          <td>
                            <strong className="set-symbol">{trade.tradingsymbol || trade.symbol || 'Unknown'}</strong>
                          </td>
                          <td>
                            <span className={`set-source set-source--${trade.source === 'momentum-trade' ? 'momentum' : 'positions'}`}>
                              {trade.source === 'momentum-trade' ? 'Momentum' : 'Positions page'}
                            </span>
                          </td>
                          <td className="set-num">{formatMoney(trade.entry_price, trade.broker)}</td>
                          <td className="set-num">{formatMoney(trade.exit_price, trade.broker)}</td>
                          <td className={`set-num set-pnl ${trade.pnl != null && trade.pnl > 0 ? 'set-positive' : trade.pnl != null && trade.pnl < 0 ? 'set-negative' : ''}`}>
                            <strong>{formatMoney(trade.pnl, trade.broker)}</strong>
                          </td>
                          <td className={`set-num set-pnl ${trade.pnl_pct != null && trade.pnl_pct > 0 ? 'set-positive' : trade.pnl_pct != null && trade.pnl_pct < 0 ? 'set-negative' : ''}`}>
                            <strong>{formatPct(trade.pnl_pct)}</strong>
                          </td>
                        </tr>
                      )
                    }

                    const expanded = Boolean(expandedSessions[row.sessionId])
                    const label = row.symbols.length
                      ? row.symbols.slice(0, 3).join(', ') + (row.symbols.length > 3 ? ` +${row.symbols.length - 3}` : '')
                      : '1% session'
                    return (
                      <Fragment key={`session-${row.sessionId}`}>
                        <tr
                          className={`set-session-row${expanded ? ' set-session-row--open' : ''}`}
                        >
                          <td>
                            <button
                              type="button"
                              className="set-session-toggle"
                              aria-expanded={expanded}
                              onClick={() => toggleSession(row.sessionId)}
                            >
                              <span className="set-session-toggle__chevron" aria-hidden="true">
                                {expanded ? '▾' : '▸'}
                              </span>
                              <span>
                                <strong className="set-symbol">{label}</strong>
                                <span className="set-session-toggle__meta">
                                  {row.trades.length} trade{row.trades.length === 1 ? '' : 's'} · {row.accountEnv.toUpperCase()}
                                </span>
                              </span>
                            </button>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="set-source set-source--onepc set-source--session"
                              title={row.sessionId}
                              onClick={() => toggleSession(row.sessionId)}
                            >
                              1% · {shortSessionId(row.sessionId)}
                            </button>
                          </td>
                          <td className="set-num">—</td>
                          <td className="set-num">—</td>
                          <td className={`set-num set-pnl ${row.pnl > 0 ? 'set-positive' : row.pnl < 0 ? 'set-negative' : ''}`}>
                            <strong>{formatMoney(row.pnl, row.broker)}</strong>
                          </td>
                          <td className="set-num">—</td>
                        </tr>
                        {expanded
                          ? row.trades.map(trade => (
                              <tr key={trade.id} className="set-session-child">
                                <td>
                                  <strong className="set-symbol">{trade.tradingsymbol || trade.symbol || 'Unknown'}</strong>
                                  {trade.attempt_id ? (
                                    <span className="set-session-child__attempt">
                                      attempt {shortSessionId(trade.attempt_id)}
                                    </span>
                                  ) : null}
                                </td>
                                <td>
                                  <span className="set-source set-source--onepc">1% trade</span>
                                </td>
                                <td className="set-num">{formatMoney(trade.entry_price, trade.broker)}</td>
                                <td className="set-num">{formatMoney(trade.exit_price, trade.broker)}</td>
                                <td className={`set-num set-pnl ${trade.pnl != null && trade.pnl > 0 ? 'set-positive' : trade.pnl != null && trade.pnl < 0 ? 'set-negative' : ''}`}>
                                  <strong>{formatMoney(trade.pnl, trade.broker)}</strong>
                                </td>
                                <td className={`set-num set-pnl ${trade.pnl_pct != null && trade.pnl_pct > 0 ? 'set-positive' : trade.pnl_pct != null && trade.pnl_pct < 0 ? 'set-negative' : ''}`}>
                                  <strong>{formatPct(trade.pnl_pct)}</strong>
                                </td>
                              </tr>
                            ))
                          : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="set-empty">
              <span className="set-empty__icon"><Activity aria-hidden="true" /></span>
              <strong>No finalized {environmentFilter === 'all' ? '' : `${environmentFilter} `}trades yet</strong>
              <p>Completed Momentum trades and closes from the Positions page will appear here.</p>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
