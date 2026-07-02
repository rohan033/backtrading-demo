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

export default function AgentTradePnlTable({
  threadId,
  pollMs = 8_000,
  refreshKey = 0,
  symbolFilter = null,
}: Props) {
  const [rows, setRows] = useState<AgentTradeLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const filterRoot = symbolRoot(symbolFilter)
  const visibleRows = useMemo(
    () => (filterRoot ? rows.filter(row => symbolRoot(row.symbol) === filterRoot) : rows),
    [filterRoot, rows],
  )
  const fetchRows = useCallback(async () => {
    try {
      const data = await listAgentTradeLogs(threadId)
      setRows(data)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load PnL')
    } finally {
      setLoading(false)
    }
  }, [threadId])

  useEffect(() => {
    setLoading(true)
    void fetchRows()
    const id = window.setInterval(() => { void fetchRows() }, pollMs)
    return () => window.clearInterval(id)
  }, [fetchRows, pollMs, refreshKey])

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

  if (!visibleRows.length) {
    return <div className="am-pnl-empty">Closed trades will appear here with PnL.</div>
  }

  return (
    <section className="am-pnl">
      <div className="am-pnl__title">Trade PnL</div>
      <table className="am-pnl__table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Outcome</th>
            <th>PnL</th>
            <th>%</th>
            <th>Entry</th>
            <th>Exit</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(row => {
            const outcome = (row.outcome || '').toLowerCase()
            const pnlClass = row.pnl != null && row.pnl >= 0 ? 'am-pnl__pos' : 'am-pnl__neg'
            return (
              <tr key={row.id} className={`am-pnl__row am-pnl__row--${outcome || 'unknown'}`}>
                <td>{row.symbol || '—'}</td>
                <td>{row.outcome || '—'}</td>
                <td className={pnlClass}>{formatMoney(row.pnl)}</td>
                <td className={pnlClass}>{formatPct(row.pnl_pct)}</td>
                <td>{row.entry_price != null ? Number(row.entry_price).toFixed(2) : '—'}</td>
                <td>{row.exit_price != null ? Number(row.exit_price).toFixed(2) : '—'}</td>
                <td className="am-pnl__notes">{row.notes || '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
