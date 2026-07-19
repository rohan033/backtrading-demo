import { useCallback, useEffect, useMemo, useState } from 'react'

import { listAgentTradeLogs, type AgentTradeLog } from '@/lib/agentThreads'

type Props = {
  threadId: string
  pollMs?: number
  refreshKey?: number
  symbolFilter?: string | null
}

function symbolRoot(value: string | null | undefined): string {
  return String(value || '').split('-')[0].toUpperCase()
}

function formatMoney(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}`
}

function formatPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(2)}%`
}

function toIsoRangeStart(value: string): string | undefined {
  if (!value) return undefined
  return `${value}T00:00:00.000Z`
}

function toIsoRangeEnd(value: string): string | undefined {
  if (!value) return undefined
  return `${value}T23:59:59.999Z`
}

function toDateInputValue(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function shiftDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime())
  copy.setUTCDate(copy.getUTCDate() + days)
  return copy
}

export default function AgentTradePnlTable({
  threadId,
  pollMs = 8_000,
  refreshKey = 0,
  symbolFilter = null,
}: Props) {
  const [rows, setRows] = useState<AgentTradeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [preset, setPreset] = useState<
    'all' | 'last_7d' | 'last_30d' | 'last_week' | 'last_month' | 'x_days' | 'custom'
  >('last_30d')
  const [xDays, setXDays] = useState('14')
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState(today)

  const dateRange = useMemo(() => {
    const now = new Date()
    if (preset === 'all') return { startDate: undefined, endDate: undefined }
    if (preset === 'custom') {
      return {
        startDate: toIsoRangeStart(fromDate),
        endDate: toIsoRangeEnd(toDate),
      }
    }
    if (preset === 'x_days') {
      const days = Math.max(1, Math.min(3650, Number(xDays) || 1))
      return {
        startDate: shiftDays(now, -days).toISOString(),
        endDate: now.toISOString(),
      }
    }
    if (preset === 'last_7d') {
      return {
        startDate: shiftDays(now, -7).toISOString(),
        endDate: now.toISOString(),
      }
    }
    if (preset === 'last_30d') {
      return {
        startDate: shiftDays(now, -30).toISOString(),
        endDate: now.toISOString(),
      }
    }
    if (preset === 'last_week') {
      const end = now
      const start = shiftDays(end, -7)
      return { startDate: start.toISOString(), endDate: end.toISOString() }
    }
    // last_month
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1, 0, 0, 0, 0))
    return {
      startDate: start.toISOString(),
      endDate: new Date(end.getTime() - 1).toISOString(),
    }
  }, [fromDate, preset, toDate, xDays])

  const filterRoot = symbolRoot(symbolFilter)
  const visibleRows = useMemo(
    () => (filterRoot ? rows.filter(row => symbolRoot(row.symbol) === filterRoot) : rows),
    [filterRoot, rows],
  )
  const fetchRows = useCallback(async () => {
    try {
      const data = await listAgentTradeLogs(threadId, {
        limit: 500,
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      })
      setRows(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PnL')
    } finally {
      setLoading(false)
    }
  }, [dateRange.endDate, dateRange.startDate, threadId])

  useEffect(() => {
    setLoading(true)
    void fetchRows()
    const id = window.setInterval(() => { void fetchRows() }, pollMs)
    return () => window.clearInterval(id)
  }, [fetchRows, pollMs, refreshKey])

  const totals = useMemo(() => {
    const totalPnl = visibleRows.reduce((sum, row) => sum + (Number(row.pnl) || 0), 0)
    const capital = visibleRows.reduce((sum, row) => sum + Math.max(0, Number(row.capital) || 0), 0)
    const totalPct = capital > 0
      ? (totalPnl / capital) * 100
      : null
    return { totalPnl, capital, totalPct, count: visibleRows.length }
  }, [visibleRows])

  if (loading && !visibleRows.length) {
    return <div className="am-pnl-empty">Loading trade PnL…</div>
  }

  if (error && !visibleRows.length) {
    return (
      <div className="am-pnl-empty">
        {error}
        <button type="button" className="am-pnl-retry" onClick={() => { void fetchRows() }}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <section className="am-pnl">
      <div className="am-pnl__header">
        <div className="am-pnl__title">Trade PnL</div>
        <div className="am-pnl__totals">
          <span>{totals.count} trades</span>
          <span className={totals.totalPnl >= 0 ? 'am-pnl__pos' : 'am-pnl__neg'}>
            Net {formatMoney(totals.totalPnl)}
          </span>
          <span className={totals.totalPnl >= 0 ? 'am-pnl__pos' : 'am-pnl__neg'}>
            Net {formatPct(totals.totalPct)}
          </span>
        </div>
      </div>
      <div className="am-pnl__filters">
        <label>
          <span>Range</span>
          <select value={preset} onChange={event => setPreset(event.target.value as typeof preset)}>
            <option value="all">All dates</option>
            <option value="last_7d">Last 7 days</option>
            <option value="last_30d">Last 30 days</option>
            <option value="last_week">Last week</option>
            <option value="last_month">Last month</option>
            <option value="x_days">Last X days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {preset === 'x_days' ? (
          <label>
            <span>X days</span>
            <input
              type="number"
              min={1}
              max={3650}
              value={xDays}
              onChange={event => setXDays(event.target.value)}
            />
          </label>
        ) : null}
        {preset === 'custom' ? (
          <>
            <label>
              <span>From</span>
              <input type="date" value={fromDate} onChange={event => setFromDate(event.target.value)} />
            </label>
            <label>
              <span>To</span>
              <input type="date" value={toDate} onChange={event => setToDate(event.target.value)} />
            </label>
          </>
        ) : null}
      </div>
      <table className="am-pnl__table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Symbol</th>
            <th>Outcome</th>
            <th>Net PnL</th>
            <th>Net %</th>
            <th>Capital</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(row => {
            const outcome = (row.outcome || '').toLowerCase()
            const pnlClass = row.pnl != null && row.pnl >= 0 ? 'am-pnl__pos' : 'am-pnl__neg'
            return [
                <tr key={row.id} className={`am-pnl__row am-pnl__row--${outcome || 'unknown'}`}>
                  <td>{new Date(row.created_at).toLocaleDateString()}</td>
                  <td>{row.symbol || '—'}</td>
                  <td>{row.outcome || '—'}</td>
                  <td className={pnlClass}>{formatMoney(row.pnl)}</td>
                  <td className={pnlClass}>{formatPct(row.pnl_pct)}</td>
                  <td>{row.capital != null ? Number(row.capital).toFixed(2) : '—'}</td>
                  <td className="am-pnl__notes">{row.notes || '—'}</td>
                </tr>,
                <tr key={`${row.id}__legs`} className="am-pnl__subrow">
                  <td colSpan={7}>
                    <div className="am-pnl__legs">
                      <span><strong>Buy</strong> {row.entry_price != null ? Number(row.entry_price).toFixed(2) : '—'}</span>
                      <span><strong>Sell</strong> {row.exit_price != null ? Number(row.exit_price).toFixed(2) : '—'}</span>
                      <span className={pnlClass}><strong>Profit %</strong> {formatPct(row.pnl_pct)}</span>
                    </div>
                  </td>
                </tr>,
              ]
          })}
          {!visibleRows.length ? (
            <tr>
              <td colSpan={7} className="am-pnl__no-rows">
                Closed trades will appear here with PnL.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  )
}
