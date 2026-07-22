import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Bell,
  BellOff,
  Download,
  ListPlus,
  OctagonAlert,
  RefreshCw,
  Rss,
  Settings2,
  Trash2,
} from 'lucide-react'
import {
  deleteOlderTradeHalts,
  fetchTradeHaltNotifySettings,
  fetchTradeHaltsForDay,
  rankHotHaltSymbols,
  setTradeHaltGlobalNotifyEnabled,
  setTradeHaltNotifyEnabled,
  type TradeHalt,
} from '../lib/tradeHalts'
import './SettingsPage.css'

type SettingsSection = 'order-activity' | 'halts'

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

type DatePreset = 'all' | 'last_7d' | 'last_30d' | 'last_week' | 'last_month' | 'x_days' | 'custom'

type ImportSource = 'positions' | 'bracket' | 'momentum-trade' | 'manual'

type EtoroDayTrade = {
  position_id: string
  order_id: string | null
  instrument_id: number | null
  symbol: string
  ticker: string
  is_buy: boolean
  units: number | null
  investment: number | null
  entry_price: number | null
  exit_price: number | null
  pnl: number | null
  pnl_pct: number | null
  fees: number | null
  opened_at: string | null
  closed_at: string | null
  already_imported: boolean
}

const IMPORT_SOURCES: Array<{ value: ImportSource; label: string }> = [
  { value: 'positions', label: 'Positions' },
  { value: 'bracket', label: 'Bracket' },
  { value: 'momentum-trade', label: 'Momentum' },
  { value: 'manual', label: 'Manual' },
]

function sourcePillClass(source: string): string {
  if (source === 'momentum-trade') return 'momentum'
  if (source === '1pc_session') return 'onepc'
  if (source === 'manual') return 'manual'
  if (source === 'bracket') return 'bracket'
  return 'positions'
}

function sourceLabel(source: string): string {
  if (source === 'momentum-trade') return 'Momentum'
  if (source === '1pc_session') return '1%'
  if (source === 'manual') return 'Manual'
  if (source === 'bracket') return 'Bracket'
  return 'Positions'
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

function formatDateTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function toDateInputValue(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfDay(dateLike: string): Date | null {
  if (!dateLike) return null
  const date = new Date(`${dateLike}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function endOfDay(dateLike: string): Date | null {
  if (!dateLike) return null
  const date = new Date(`${dateLike}T23:59:59.999`)
  return Number.isNaN(date.getTime()) ? null : date
}

function tradeTimestamp(trade: MomentumTrade): number {
  const raw = trade.closed_at || trade.opened_at
  const ms = new Date(raw).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

function tradeProfitPct(trade: MomentumTrade): number | null {
  if (trade.pnl_pct != null && Number.isFinite(trade.pnl_pct)) return trade.pnl_pct
  const pnl = Number(trade.pnl)
  const capital = Number(trade.capital)
  if (!Number.isFinite(pnl) || !Number.isFinite(capital) || capital <= 0) return null
  return (pnl / capital) * 100
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

function pnlTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'set-pos' : 'set-neg'
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

function NestedTradeTable({ trades }: { trades: MomentumTrade[] }) {
  return (
    <div className="set-nested">
      <table className="set-nested-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th className="set-num">Buy</th>
            <th className="set-num">Sell</th>
            <th className="set-num">Profit</th>
            <th className="set-num">Profit %</th>
            <th>Opened</th>
            <th>Closed</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(trade => {
            const pct = tradeProfitPct(trade)
            return (
              <tr key={trade.id}>
                <td>
                  <strong className="set-sym">{trade.tradingsymbol || trade.symbol || '—'}</strong>
                  {trade.attempt_id ? (
                    <span className="set-meta">attempt {shortSessionId(trade.attempt_id)}</span>
                  ) : null}
                </td>
                <td className="set-num">{formatMoney(trade.entry_price, trade.broker)}</td>
                <td className="set-num">{formatMoney(trade.exit_price, trade.broker)}</td>
                <td className={`set-num ${pnlTone(trade.pnl)}`}>
                  {formatMoney(trade.pnl, trade.broker)}
                </td>
                <td className={`set-num ${pnlTone(pct)}`}>{formatPct(pct)}</td>
                <td>{formatDateTime(trade.opened_at)}</td>
                <td>{formatDateTime(trade.closed_at)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function formatHaltWhen(dateValue: string | null | undefined, timeValue: string | null | undefined): string {
  const datePart = (dateValue || '').trim()
  const timePart = (timeValue || '').trim().replace(/\.000$/, '')
  if (!datePart && !timePart) return '—'
  if (!timePart) return datePart
  if (!datePart) return timePart
  return `${datePart} ${timePart}`
}

function HaltsPanel() {
  const [dayFilter, setDayFilter] = useState<'all' | string>('all')
  const [halts, setHalts] = useState<TradeHalt[]>([])
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [polling, setPolling] = useState(false)
  const [purging, setPurging] = useState(false)
  const [togglingGlobal, setTogglingGlobal] = useState(false)
  const [togglingSymbol, setTogglingSymbol] = useState<string | null>(null)
  const [error, setError] = useState('')

  const loadHalts = useCallback(async (opts?: { soft?: boolean }) => {
    const soft = Boolean(opts?.soft)
    if (soft) setRefreshing(true)
    else setLoading(true)
    setError('')
    try {
      const [result, prefs] = await Promise.all([
        fetchTradeHaltsForDay(dayFilter === 'all' ? null : dayFilter, 'LUDP'),
        fetchTradeHaltNotifySettings(),
      ])
      setHalts(result.data)
      setNotificationsEnabled(prefs.notifications_enabled)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trade halts')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [dayFilter])

  useEffect(() => {
    void loadHalts()
  }, [loadHalts])

  const pollNow = async () => {
    setPolling(true)
    setError('')
    try {
      const res = await fetch('/api/trade-halts/poll', { method: 'POST' })
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { detail?: string }
        throw new Error(payload.detail || 'Poll failed')
      }
      await loadHalts({ soft: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Poll failed')
    } finally {
      setPolling(false)
    }
  }

  const deleteOlder = async () => {
    const keepDay = dayFilter === 'all' ? toDateInputValue(new Date()) : dayFilter
    const confirmed = window.confirm(
      `Delete all trade halts older than ${keepDay}? Today's (and newer) LUDP rows are kept.`,
    )
    if (!confirmed) return
    setPurging(true)
    setError('')
    try {
      await deleteOlderTradeHalts(keepDay)
      await loadHalts({ soft: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete older halts')
    } finally {
      setPurging(false)
    }
  }

  const toggleGlobalNotify = async () => {
    const next = !notificationsEnabled
    setTogglingGlobal(true)
    setError('')
    try {
      await setTradeHaltGlobalNotifyEnabled(next)
      setNotificationsEnabled(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update global notifications')
    } finally {
      setTogglingGlobal(false)
    }
  }

  const toggleNotify = async (halt: TradeHalt) => {
    const next = !(halt.notify_enabled !== false)
    setTogglingSymbol(halt.symbol)
    setError('')
    try {
      await setTradeHaltNotifyEnabled(halt.symbol, next)
      setHalts(prev =>
        prev.map(item =>
          item.symbol === halt.symbol ? { ...item, notify_enabled: next } : item,
        ),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update notifications')
    } finally {
      setTogglingSymbol(null)
    }
  }

  const hotSymbols = useMemo(() => rankHotHaltSymbols(halts, 6), [halts])

  return (
    <section className="set-content" aria-labelledby="trade-halts-title">
      <div className="set-toolbar">
        <div className="set-toolbar__title">
          <span className="set-eyebrow">NASDAQ</span>
          <h2 id="trade-halts-title">Trade halts</h2>
        </div>
        <div className="set-toolbar__spacer" />
        <button
          type="button"
          className={`set-notify-toggle set-notify-toggle--global${
            notificationsEnabled ? ' set-notify-toggle--on' : ''
          }`}
          aria-pressed={notificationsEnabled}
          aria-label={
            notificationsEnabled
              ? 'Disable all halt notifications'
              : 'Enable all halt notifications'
          }
          disabled={togglingGlobal}
          onClick={() => void toggleGlobalNotify()}
        >
          {notificationsEnabled ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}
          <span>{notificationsEnabled ? 'Notifications on' : 'Notifications off'}</span>
        </button>
        <label className="set-date">
          <span>Day</span>
          <select
            value={dayFilter === 'all' ? 'all' : dayFilter}
            onChange={event => {
              const value = event.target.value
              setDayFilter(value === 'all' ? 'all' : value)
            }}
          >
            <option value="all">All (feed)</option>
            <option value={toDateInputValue(new Date())}>Today</option>
            <option value={toDateInputValue(new Date(Date.now() - 86400000))}>Yesterday</option>
          </select>
        </label>
        {dayFilter !== 'all' ? (
          <label className="set-date">
            <span>Custom</span>
            <input
              type="date"
              value={dayFilter}
              onChange={event => setDayFilter(event.target.value || 'all')}
            />
          </label>
        ) : null}
        <button
          type="button"
          className="set-btn"
          onClick={() => void loadHalts({ soft: true })}
          disabled={refreshing || loading}
        >
          <RefreshCw className={refreshing ? 'set-spin' : ''} aria-hidden="true" />
          {refreshing ? 'Refreshing' : 'Refresh'}
        </button>
        <button
          type="button"
          className="set-btn"
          onClick={() => void deleteOlder()}
          disabled={purging || loading}
          title="Delete halt rows older than today (or the selected day)"
        >
          <Trash2 aria-hidden="true" />
          {purging ? 'Deleting…' : 'Delete older'}
        </button>
        <button
          type="button"
          className="set-btn set-btn--primary"
          onClick={() => void pollNow()}
          disabled={polling}
        >
          <Rss aria-hidden="true" />
          {polling ? 'Polling…' : 'Poll feed'}
        </button>
      </div>

      {!notificationsEnabled ? (
        <div className="set-halt-banner" role="status">
          Halt toast notifications are disabled globally. Feed data still updates.
        </div>
      ) : null}

      <div className="set-summary set-summary--halts" aria-label="Hot repeatedly halted stocks">
        <div className="set-summary__label">
          <span className="set-eyebrow">Hot</span>
          <strong>LUDP</strong>
        </div>
        <div className="set-halt-ticker" role="list">
          {loading ? (
            <div className="set-halt-ticker__empty">Loading…</div>
          ) : !hotSymbols.length ? (
            <div className="set-halt-ticker__empty">No LUDP repeats yet</div>
          ) : (
            hotSymbols.map(item => (
              <article
                key={item.symbol}
                className={`set-halt-ticker-card set-halt-ticker-card--${
                  item.last_status === 'resumed' ? 'resumed' : 'halted'
                }`}
                role="listitem"
                title={item.issue_name || item.symbol}
              >
                <strong className="set-halt-ticker-card__sym">{item.symbol}</strong>
                <span className="set-halt-ticker-card__count">
                  {item.halt_count}×
                </span>
                <em className="set-halt-ticker-card__status">
                  {item.last_status === 'resumed' ? 'Resumed' : 'Halted'}
                </em>
              </article>
            ))
          )}
        </div>
      </div>

      <div className="set-body">
        {error ? <div className="set-error">{error}</div> : null}
        {loading ? (
          <div className="set-empty">Loading LUDP trade halts…</div>
        ) : !halts.length ? (
          <div className="set-empty">
            <strong>No LUDP trade halts stored</strong>
            <p>Use Poll feed to refresh from NASDAQ, or pick All (feed) / another day.</p>
          </div>
        ) : (
          <div className="set-table-scroll">
            <div className="set-table-card">
              <table className="set-table set-table--halts">
                <thead>
                  <tr className="set-thead-row set-thead-row--halts">
                    <th className="set-th set-th--first" scope="col">
                      Symbol
                    </th>
                    <th className="set-th" scope="col">
                      Status
                    </th>
                    <th className="set-th" scope="col">
                      Reason
                    </th>
                    <th className="set-th" scope="col">
                      Market
                    </th>
                    <th className="set-th" scope="col">
                      Halted
                    </th>
                    <th className="set-th" scope="col">
                      Resumption
                    </th>
                    <th className="set-th" scope="col">
                      Issue
                    </th>
                    <th className="set-th" scope="col">
                      Notify
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {halts.map(halt => {
                    const notifyOn = halt.notify_enabled !== false
                    const busy = togglingSymbol === halt.symbol
                    return (
                      <tr key={halt.id} className="set-table-row">
                        <td className="set-td set-td--first">
                          <strong className="set-sym">{halt.symbol}</strong>
                        </td>
                        <td className="set-td">
                          <span
                            className={`set-halt-pill set-halt-pill--${
                              halt.status === 'resumed' ? 'resumed' : 'halted'
                            }`}
                          >
                            {halt.status === 'resumed' ? 'Resumed' : 'Halted'}
                          </span>
                        </td>
                        <td className="set-td">{halt.reason_code || '—'}</td>
                        <td className="set-td">{halt.market || '—'}</td>
                        <td className="set-td">
                          {formatHaltWhen(halt.halt_date, halt.halt_time)}
                        </td>
                        <td className="set-td">
                          {formatHaltWhen(halt.resumption_date, halt.resumption_trade_time)}
                        </td>
                        <td className="set-td">
                          <span className="set-halt-issue">{halt.issue_name || '—'}</span>
                        </td>
                        <td className="set-td">
                          <button
                            type="button"
                            className={`set-notify-toggle${notifyOn ? ' set-notify-toggle--on' : ''}`}
                            aria-pressed={notifyOn}
                            aria-label={
                              notifyOn
                                ? `Disable notifications for ${halt.symbol}`
                                : `Enable notifications for ${halt.symbol}`
                            }
                            disabled={busy || !notificationsEnabled}
                            title={
                              !notificationsEnabled
                                ? 'Turn on global notifications first'
                                : undefined
                            }
                            onClick={() => void toggleNotify(halt)}
                          >
                            {notifyOn ? (
                              <Bell aria-hidden="true" />
                            ) : (
                              <BellOff aria-hidden="true" />
                            )}
                            <span>{notifyOn ? 'On' : 'Off'}</span>
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>('order-activity')
  const [trades, setTrades] = useState<MomentumTrade[]>([])
  const [summary, setSummary] = useState<MomentumSummary>(EMPTY_SUMMARY)
  const [environmentFilter, setEnvironmentFilter] = useState<'all' | 'live' | 'demo'>('all')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [expandedSessions, setExpandedSessions] = useState<Record<string, boolean>>({})
  const [expandedTrades, setExpandedTrades] = useState<Record<string, boolean>>({})
  const [datePreset, setDatePreset] = useState<DatePreset>('last_30d')
  const [xDays, setXDays] = useState('14')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState(() => toDateInputValue(new Date()))

  const [importOpen, setImportOpen] = useState(false)
  const [importEnv, setImportEnv] = useState<'live' | 'demo'>('live')
  const [importDay, setImportDay] = useState(() => toDateInputValue(new Date()))
  const [importTicker, setImportTicker] = useState('')
  const [importSource, setImportSource] = useState<ImportSource>('positions')
  const [importRows, setImportRows] = useState<EtoroDayTrade[]>([])
  const [importLoading, setImportLoading] = useState(false)
  const [importError, setImportError] = useState('')
  const [importingIds, setImportingIds] = useState<Record<string, boolean>>({})

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

  const loadEtoroDay = useCallback(async () => {
    setImportLoading(true)
    setImportError('')
    try {
      const params = new URLSearchParams({
        account_env: importEnv,
        day: importDay,
      })
      const ticker = importTicker.trim()
      if (ticker) params.set('ticker', ticker)
      const response = await fetch(`/api/trades-pnl/etoro-day?${params}`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: string }
        throw new Error(body.detail || `Request failed (${response.status})`)
      }
      const payload = await response.json() as { status?: boolean; data?: EtoroDayTrade[] }
      if (!payload.status) throw new Error('Could not load eToro day trades')
      setImportRows(payload.data || [])
      setImportOpen(true)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to load eToro trades')
      setImportRows([])
    } finally {
      setImportLoading(false)
    }
  }, [importDay, importEnv, importTicker])

  const importTrade = useCallback(async (row: EtoroDayTrade) => {
    if (!row.position_id) return
    setImportingIds(prev => ({ ...prev, [row.position_id]: true }))
    setImportError('')
    try {
      const response = await fetch('/api/trades-pnl/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_env: importEnv,
          position_id: row.position_id,
          source: importSource,
          symbol: row.symbol,
          entry_price: row.entry_price,
          exit_price: row.exit_price,
          pnl: row.pnl,
          pnl_pct: row.pnl_pct,
          units: row.units,
          investment: row.investment,
          order_id: row.order_id,
          opened_at: row.opened_at,
          closed_at: row.closed_at,
          close_reason: 'manual_import',
        }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { detail?: string }
        throw new Error(body.detail || `Import failed (${response.status})`)
      }
      setImportRows(prev => prev.map(item => (
        item.position_id === row.position_id ? { ...item, already_imported: true } : item
      )))
      await loadTrades(true)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Failed to import trade')
    } finally {
      setImportingIds(prev => {
        const next = { ...prev }
        delete next[row.position_id]
        return next
      })
    }
  }, [importEnv, importSource, loadTrades])

  const filteredImportRows = useMemo(() => {
    const q = importTicker.trim().toUpperCase()
    if (!q) return importRows
    return importRows.filter(row =>
      row.ticker.toUpperCase().includes(q)
      || row.symbol.toUpperCase().includes(q),
    )
  }, [importRows, importTicker])

  const visibleTrades = useMemo(() => {
    const now = new Date()
    let rangeStart: Date | null = null
    let rangeEnd: Date | null = null
    if (datePreset === 'last_7d' || datePreset === 'last_week') {
      rangeEnd = now
      rangeStart = new Date(now.getTime() - 7 * 86400_000)
    } else if (datePreset === 'last_30d') {
      rangeEnd = now
      rangeStart = new Date(now.getTime() - 30 * 86400_000)
    } else if (datePreset === 'last_month') {
      const firstCurrent = new Date(now.getFullYear(), now.getMonth(), 1)
      rangeEnd = new Date(firstCurrent.getTime() - 1)
      rangeStart = new Date(firstCurrent.getFullYear(), firstCurrent.getMonth() - 1, 1)
    } else if (datePreset === 'x_days') {
      const days = Math.max(1, Math.min(3650, Number(xDays) || 1))
      rangeEnd = now
      rangeStart = new Date(now.getTime() - days * 86400_000)
    } else if (datePreset === 'custom') {
      rangeStart = startOfDay(fromDate)
      rangeEnd = endOfDay(toDate)
    }

    return trades.filter(trade => {
      if (environmentFilter !== 'all' && trade.account_env.toLowerCase() !== environmentFilter) return false
      if (!rangeStart && !rangeEnd) return true
      const stamp = tradeTimestamp(trade)
      if (!stamp) return false
      if (rangeStart && stamp < rangeStart.getTime()) return false
      if (rangeEnd && stamp > rangeEnd.getTime()) return false
      return true
    })
  }, [datePreset, environmentFilter, fromDate, toDate, trades, xDays])

  const ledgerRows = useMemo(() => buildLedgerRows(visibleTrades), [visibleTrades])

  const visibleSummary = useMemo(() => {
    const wins = visibleTrades.filter(trade => (trade.pnl || 0) > 0).length
    const losses = visibleTrades.filter(trade => (trade.pnl || 0) < 0).length
    const realizedPnl = visibleTrades.reduce((total, trade) => total + (trade.pnl || 0), 0)
    const usedCapital = visibleTrades.reduce((total, trade) => total + Math.max(0, trade.capital || 0), 0)
    return {
      ...summary,
      total_trades: visibleTrades.length,
      closed_trades: visibleTrades.length,
      realized_pnl: realizedPnl,
      realized_pct: usedCapital > 0 ? (realizedPnl / usedCapital) * 100 : null,
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
        <button
          type="button"
          className={`set-nav__item${section === 'order-activity' ? ' set-nav__item--active' : ''}`}
          aria-current={section === 'order-activity' ? 'page' : undefined}
          onClick={() => setSection('order-activity')}
        >
          <span className="set-nav__icon"><Activity aria-hidden="true" /></span>
          <span>
            <strong>Order activity</strong>
            <small>Momentum P&amp;L</small>
          </span>
        </button>
        <button
          type="button"
          className={`set-nav__item${section === 'halts' ? ' set-nav__item--active' : ''}`}
          aria-current={section === 'halts' ? 'page' : undefined}
          onClick={() => setSection('halts')}
        >
          <span className="set-nav__icon set-nav__icon--halts"><OctagonAlert aria-hidden="true" /></span>
          <span>
            <strong>Halts</strong>
            <small>NASDAQ trade halts</small>
          </span>
        </button>
        <p className="set-nav__footnote">More workspace settings will appear here.</p>
      </aside>

      {section === 'halts' ? (
        <HaltsPanel />
      ) : (
      <section className="set-content" aria-labelledby="order-activity-title">
        <div className="set-toolbar">
          <div className="set-toolbar__title">
            <span className="set-eyebrow">Momentum</span>
            <h2 id="order-activity-title">Order activity</h2>
          </div>
          <div className="set-toolbar__spacer" />
          <div className="set-env" role="group" aria-label="Account environment">
            {(['all', 'live', 'demo'] as const).map(environment => (
              <button
                type="button"
                key={environment}
                className={environmentFilter === environment ? 'set-env__active' : ''}
                aria-pressed={environmentFilter === environment}
                onClick={() => setEnvironmentFilter(environment)}
              >
                {environment[0].toUpperCase() + environment.slice(1)}
              </button>
            ))}
          </div>
          <label className="set-date">
            <span>Date</span>
            <select value={datePreset} onChange={event => setDatePreset(event.target.value as DatePreset)}>
              <option value="all">All</option>
              <option value="last_7d">7d</option>
              <option value="last_30d">30d</option>
              <option value="last_week">Week</option>
              <option value="last_month">Month</option>
              <option value="x_days">X days</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          {datePreset === 'x_days' ? (
            <label className="set-date">
              <span>X</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={xDays}
                onChange={event => setXDays(event.target.value)}
              />
            </label>
          ) : null}
          {datePreset === 'custom' ? (
            <>
              <label className="set-date">
                <span>From</span>
                <input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
              </label>
              <label className="set-date">
                <span>To</span>
                <input type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
              </label>
            </>
          ) : null}
          <button
            type="button"
            className="set-btn"
            onClick={() => void loadTrades(true)}
            disabled={refreshing}
          >
            <RefreshCw className={refreshing ? 'set-spin' : ''} aria-hidden="true" />
            {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
          <button
            type="button"
            className="set-btn"
            onClick={() => {
              setImportOpen(true)
              if (!importRows.length) void loadEtoroDay()
            }}
            disabled={importLoading}
          >
            <ListPlus aria-hidden="true" />
            {importLoading ? 'Loading eToro…' : 'Import eToro day'}
          </button>
          <a className="set-btn set-btn--primary" href={downloadUrl}>
            <Download aria-hidden="true" />
            CSV
          </a>
        </div>

        {importOpen ? (
          <details className="set-import" open>
            <summary className="set-import__summary">
              <span>Import from eToro</span>
              <em>{filteredImportRows.length}</em>
            </summary>
            <div className="set-import__controls">
              <div className="set-env" role="group" aria-label="Import account">
                {(['live', 'demo'] as const).map(environment => (
                  <button
                    type="button"
                    key={environment}
                    className={importEnv === environment ? 'set-env__active' : ''}
                    aria-pressed={importEnv === environment}
                    onClick={() => setImportEnv(environment)}
                  >
                    {environment[0].toUpperCase() + environment.slice(1)}
                  </button>
                ))}
              </div>
              <label className="set-date">
                <span>Day</span>
                <input type="date" value={importDay} onChange={event => setImportDay(event.target.value)} />
              </label>
              <label className="set-date">
                <span>Ticker</span>
                <input
                  type="text"
                  placeholder="ZYBT"
                  value={importTicker}
                  onChange={event => setImportTicker(event.target.value)}
                />
              </label>
              <label className="set-date">
                <span>Source</span>
                <select
                  value={importSource}
                  onChange={event => setImportSource(event.target.value as ImportSource)}
                >
                  {IMPORT_SOURCES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="set-btn set-btn--primary"
                onClick={() => void loadEtoroDay()}
                disabled={importLoading}
              >
                {importLoading ? 'Loading…' : 'List trades'}
              </button>
              <button
                type="button"
                className="set-btn"
                onClick={() => setImportOpen(false)}
              >
                Hide
              </button>
            </div>
            {importError ? (
              <div className="set-error set-error--inline" role="alert">
                <span>{importError}</span>
              </div>
            ) : null}
            {filteredImportRows.length ? (
              <div className="set-import__table-wrap">
                <table className="set-import__table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th className="set-num">Buy</th>
                      <th className="set-num">Sell</th>
                      <th className="set-num">P&amp;L</th>
                      <th className="set-num">%</th>
                      <th>Closed</th>
                      <th>Position</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {filteredImportRows.map(row => {
                      const busy = Boolean(importingIds[row.position_id])
                      return (
                        <tr key={row.position_id}>
                          <td>
                            <strong className="set-sym">{row.ticker || row.symbol}</strong>
                            {row.units != null ? (
                              <span className="set-meta">{row.units} u</span>
                            ) : null}
                          </td>
                          <td className="set-num">{formatMoney(row.entry_price)}</td>
                          <td className="set-num">{formatMoney(row.exit_price)}</td>
                          <td className={`set-num ${pnlTone(row.pnl)}`}>{formatMoney(row.pnl)}</td>
                          <td className={`set-num ${pnlTone(row.pnl_pct)}`}>{formatPct(row.pnl_pct)}</td>
                          <td>{formatDateTime(row.closed_at)}</td>
                          <td><span className="set-meta">{row.position_id}</span></td>
                          <td>
                            <button
                              type="button"
                              className="set-btn set-btn--small"
                              disabled={busy || row.already_imported}
                              onClick={() => void importTrade(row)}
                            >
                              {row.already_imported ? 'Added' : busy ? 'Adding…' : 'Add'}
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="set-import__empty">
                {importLoading
                  ? 'Loading eToro closes…'
                  : 'No eToro closes for this day — pick Live/Demo, day, optional ticker, then List trades.'}
              </div>
            )}
          </details>
        ) : null}

        <div className="set-summary" aria-label="Order activity summary">
          <div className="set-summary__label">
            <span className="set-eyebrow">Order activity</span>
            <strong>Summary</strong>
          </div>
          <div className="set-summary__pills">
            <span className={`set-stat-pill set-stat-pill--pnl ${pnlTone(visibleSummary.realized_pnl)}`.trim()}>
              <em>PnL (Amount)</em>
              <strong>{formatMoney(visibleSummary.realized_pnl)}</strong>
            </span>
            <span className={`set-stat-pill set-stat-pill--pnl ${pnlTone(visibleSummary.realized_pct)}`.trim()}>
              <em>PnL (Percent)</em>
              <strong>{formatPct(visibleSummary.realized_pct)}</strong>
            </span>
            <span className="set-stat-pill">
              <em>Trades</em>
              <strong>{visibleSummary.closed_trades}</strong>
            </span>
            <span className="set-stat-pill set-stat-pill--wide">
              <em>Win rate</em>
              <strong>
                {visibleSummary.win_rate == null ? '—' : `${(visibleSummary.win_rate * 100).toFixed(1)}%`}
                <i>{visibleSummary.wins}W / {visibleSummary.losses}L</i>
              </strong>
            </span>
          </div>
        </div>

        {error ? (
          <div className="set-error" role="alert">
            <div>
              <strong>Could not load order activity</strong>
              <span>{error}</span>
            </div>
            <button type="button" onClick={() => void loadTrades()}>Try again</button>
          </div>
        ) : null}

        <div className="set-body">
          {loading ? (
            <div className="set-empty">Loading order activity…</div>
          ) : !visibleTrades.length ? (
            <div className="set-empty">
              <strong>No finalized {environmentFilter === 'all' ? '' : `${environmentFilter} `}trades</strong>
              <p>Completed Momentum and Positions closes will appear here.</p>
            </div>
          ) : (
            <div className="set-table-scroll">
              <div className="set-table-card">
                <table className="set-table">
                  <thead>
                    <tr className="set-thead-row">
                      <th className="set-th set-th--chevron" />
                      <th className="set-th">Ticker</th>
                      <th className="set-th">Source</th>
                      <th className="set-th set-th--num">Profit</th>
                      <th className="set-th set-th--num">Profit %</th>
                      <th className="set-th">Opened</th>
                      <th className="set-th">Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledgerRows.map(row => {
                      if (row.kind === 'trade') {
                        const trade = row.trade
                        const pct = tradeProfitPct(trade)
                        const expanded = Boolean(expandedTrades[trade.id])
                        return (
                          <Fragment key={trade.id}>
                            <tr
                              className={`set-table-row${expanded ? ' set-table-row--open' : ''}`}
                              onClick={() => setExpandedTrades(prev => ({ ...prev, [trade.id]: !prev[trade.id] }))}
                            >
                              <td className="set-td set-td--chevron">
                                <span className="set-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                              </td>
                              <td className="set-td">
                                <strong className="set-sym">{trade.tradingsymbol || trade.symbol || '—'}</strong>
                              </td>
                              <td className="set-td">
                                <span className={`set-pill set-pill--${sourcePillClass(trade.source)}`}>
                                  {sourceLabel(trade.source)}
                                </span>
                              </td>
                              <td className={`set-td set-td--num ${pnlTone(trade.pnl)}`}>
                                {formatMoney(trade.pnl, trade.broker)}
                              </td>
                              <td className={`set-td set-td--num ${pnlTone(pct)}`}>
                                {formatPct(pct)}
                              </td>
                              <td className="set-td">{formatDateTime(trade.opened_at)}</td>
                              <td className="set-td">{formatDateTime(trade.closed_at)}</td>
                            </tr>
                            {expanded ? (
                              <tr className="set-nested-row">
                                <td colSpan={7}>
                                  <NestedTradeTable trades={[trade]} />
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        )
                      }

                      const expanded = Boolean(expandedSessions[row.sessionId])
                      const label = row.symbols.length
                        ? row.symbols.slice(0, 3).join(', ') + (row.symbols.length > 3 ? ` +${row.symbols.length - 3}` : '')
                        : '1% session'
                      const sessionCapital = row.trades.reduce((total, trade) => total + Math.max(0, trade.capital || 0), 0)
                      const sessionPct = sessionCapital > 0 ? (row.pnl / sessionCapital) * 100 : null
                      return (
                        <Fragment key={`session-${row.sessionId}`}>
                          <tr
                            className={`set-table-row set-table-row--session${expanded ? ' set-table-row--open' : ''}`}
                            onClick={() => setExpandedSessions(prev => ({ ...prev, [row.sessionId]: !prev[row.sessionId] }))}
                          >
                            <td className="set-td set-td--chevron">
                              <span className="set-chevron" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
                            </td>
                            <td className="set-td">
                              <strong className="set-sym">{label}</strong>
                              <span className="set-meta">
                                {row.trades.length} trade{row.trades.length === 1 ? '' : 's'} · {row.accountEnv.toUpperCase()}
                              </span>
                            </td>
                            <td className="set-td">
                              <span className="set-pill set-pill--onepc" title={row.sessionId}>
                                1% · {shortSessionId(row.sessionId)}
                              </span>
                            </td>
                            <td className={`set-td set-td--num ${pnlTone(row.pnl)}`}>
                              {formatMoney(row.pnl, row.broker)}
                            </td>
                            <td className={`set-td set-td--num ${pnlTone(sessionPct)}`}>
                              {formatPct(sessionPct)}
                            </td>
                            <td className="set-td">
                              {formatDateTime(row.trades[row.trades.length - 1]?.opened_at ?? null)}
                            </td>
                            <td className="set-td">
                              {formatDateTime(row.trades[0]?.closed_at ?? null)}
                            </td>
                          </tr>
                          {expanded ? (
                            <tr className="set-nested-row">
                              <td colSpan={7}>
                                <NestedTradeTable trades={row.trades} />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </section>
      )}
    </div>
  )
}
