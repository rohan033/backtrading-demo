import { useCallback, useEffect, useState } from 'react'

import {
  isOpenExecutionPosition,
  loadExecutionPositions,
  type ExecutionPositionRow,
} from '@/lib/executionPositions'
import { computeLivePnl, formatPnl } from '@/lib/positionPnl'
import type { LinkedExecution } from '@/hooks/useAgentThreadExecutions'

type Props = {
  executions: LinkedExecution[]
  focusSymbol?: string | null
  broker?: string | null
  accountEnv?: string | null
  token?: string | null
  livePrice?: number | null
  pollMs?: number
}

type TableRow = {
  key: string
  symbol: string
  side: string
  units: string
  entry: string
  pnl: string
  status: string
  source: string
}

const DEFAULT_POLL_MS = 3_000

export default function AgentPositionsTable({
  executions,
  focusSymbol,
  broker,
  accountEnv,
  token,
  livePrice = null,
  pollMs = DEFAULT_POLL_MS,
}: Props) {
  const [rows, setRows] = useState<TableRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const fetchAll = useCallback(async () => {
    if (!executions.length) {
      setRows([])
      return
    }
    setLoading(true)
    setError('')
    try {
      const tableRows: TableRow[] = []
      for (const execution of executions) {
        const positions = await loadExecutionPositions({
          executorId: execution.executionId,
          broker: execution.broker || broker || 'etoro',
          accountEnv: execution.accountEnv || accountEnv || 'demo',
          symbol: execution.symbol || focusSymbol || undefined,
          token,
        })
        for (const position of positions.filter(isOpenExecutionPosition)) {
          const live = computeLivePnl(position as Parameters<typeof computeLivePnl>[0], livePrice)
          const nested = position.position || {}
          tableRows.push({
            key: `${execution.executionId}-${position.position_id}`,
            symbol: String(execution.symbol || focusSymbol || nested.symbol || '—'),
            side: String(nested.isBuy === false ? 'Sell' : nested.isBuy === true ? 'Buy' : nested.side || '—'),
            units: String(position.remaining_units ?? nested.units ?? nested.Units ?? '—'),
            entry: String(nested.openRate ?? nested.open_rate ?? nested.avgPrice ?? '—'),
            pnl: formatPnl(live) || '—',
            status: execution.status || '—',
            source: position.source,
          })
        }
      }
      setRows(tableRows)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions')
    } finally {
      setLoading(false)
    }
  }, [accountEnv, broker, executions, focusSymbol, livePrice, token])

  useEffect(() => {
    void fetchAll()
    const id = window.setInterval(() => { void fetchAll() }, pollMs)
    return () => window.clearInterval(id)
  }, [fetchAll, pollMs])

  if (!executions.length) {
    return <div className="am-positions-empty">No linked execution yet — order details will appear after deploy.</div>
  }

  if (loading && !rows.length) {
    return <div className="am-positions-empty">Loading positions…</div>
  }

  if (error) {
    return (
      <div className="am-positions-empty">
        {error}
        <button type="button" className="am-positions-retry" onClick={() => { void fetchAll() }}>
          Retry
        </button>
      </div>
    )
  }

  if (!rows.length) {
    return <div className="am-positions-empty">No open positions for this thread yet.</div>
  }

  return (
    <section className="am-positions">
      <div className="am-positions__title">Positions</div>
      <table className="am-positions__table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Side</th>
            <th>Units</th>
            <th>Entry</th>
            <th>PnL</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td>{row.symbol}</td>
              <td>{row.side}</td>
              <td>{row.units}</td>
              <td>{row.entry}</td>
              <td>{row.pnl}</td>
              <td>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
