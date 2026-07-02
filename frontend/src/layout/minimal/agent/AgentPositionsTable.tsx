import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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
  symbolFilter?: string | null
  broker?: string | null
  accountEnv?: string | null
  token?: string | number | null
  livePrice?: number | null
  pollMs?: number
  refreshKey?: number
  monitorActive?: boolean
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

type CachedPosition = {
  execution: LinkedExecution
  position: ExecutionPositionRow
}

const DEFAULT_POLL_MS = 60_000
const MONITOR_POLL_MS = 60_000
const MIN_FETCH_GAP_MS = 5_000

function buildTableRows(cached: CachedPosition[], livePrice: number | null, focusSymbol?: string | null): TableRow[] {
  return cached.map(({ execution, position }) => {
    const live = computeLivePnl(position as Parameters<typeof computeLivePnl>[0], livePrice)
    const nested = position.position || {}
    const positionState = String(position.state || nested.state || position.statusLabel || '').trim()
    return {
      key: `${execution.executionId}-${position.position_id}`,
      symbol: String(execution.symbol || focusSymbol || nested.symbol || '—'),
      side: String(nested.isBuy === false ? 'Sell' : nested.isBuy === true ? 'Buy' : nested.side || '—'),
      units: String(position.remaining_units ?? nested.units ?? nested.Units ?? '—'),
      entry: String(nested.openRate ?? nested.open_rate ?? nested.avgPrice ?? nested.averageprice ?? '—'),
      pnl: formatPnl(live?.pnl) || '—',
      status: positionState || execution.status || '—',
      source: position.source,
    }
  })
}

export default function AgentPositionsTable({
  executions,
  focusSymbol,
  symbolFilter,
  broker,
  accountEnv,
  token,
  livePrice = null,
  pollMs = DEFAULT_POLL_MS,
  refreshKey = 0,
  monitorActive = false,
}: Props) {
  const [cached, setCached] = useState<CachedPosition[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const effectivePollMs = monitorActive ? Math.min(pollMs, MONITOR_POLL_MS) : pollMs
  const isEtoro = (broker || '').toLowerCase() === 'etoro'

  const symbolRoot = (symbolFilter || focusSymbol || '').split('-')[0].toUpperCase()

  const scopedExecutions = useMemo(() => {
    if (!symbolRoot) return executions
    return executions.filter(row => {
      const sym = String(row.symbol || '').split('-')[0].toUpperCase()
      return sym === symbolRoot
    })
  }, [executions, symbolRoot])

  const executionsRef = useRef(scopedExecutions)
  executionsRef.current = scopedExecutions

  const fetchAllRef = useRef<((options?: { refreshBroker?: boolean; force?: boolean }) => Promise<void>) | null>(null)
  const inFlightRef = useRef(false)
  const lastFetchAtRef = useRef(0)

  const rows = useMemo(
    () => buildTableRows(cached, livePrice, focusSymbol)
      .filter(row => !symbolRoot || row.symbol.split('-')[0].toUpperCase() === symbolRoot),
    [cached, focusSymbol, livePrice, symbolRoot],
  )

  const fetchAll = useCallback(async (options?: { refreshBroker?: boolean; force?: boolean }) => {
    const execs = scopedExecutions
    if (!execs.length) {
      setCached([])
      return
    }

    const now = Date.now()
    if (!options?.force && inFlightRef.current) return
    if (!options?.force && now - lastFetchAtRef.current < MIN_FETCH_GAP_MS) return

    inFlightRef.current = true
    setLoading(true)
    setError('')
    try {
      const refreshBroker = Boolean(options?.refreshBroker && isEtoro)
      const next: CachedPosition[] = []
      for (const execution of execs) {
        const positions = await loadExecutionPositions({
          executorId: execution.executionId,
          broker: execution.broker || broker || 'etoro',
          accountEnv: execution.accountEnv || accountEnv || 'demo',
          symbol: execution.symbol || focusSymbol || undefined,
          token,
          refreshBroker,
        })
        for (const position of positions.filter(isOpenExecutionPosition)) {
          next.push({ execution, position })
        }
      }
      setCached(next)
      lastFetchAtRef.current = Date.now()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load positions')
    } finally {
      inFlightRef.current = false
      setLoading(false)
    }
  }, [accountEnv, broker, focusSymbol, isEtoro, scopedExecutions, token])

  fetchAllRef.current = fetchAll

  useEffect(() => {
    void fetchAllRef.current({ refreshBroker: isEtoro, force: true })
  }, [isEtoro, refreshKey])

  useEffect(() => {
    const id = window.setInterval(() => {
      void fetchAllRef.current?.({ refreshBroker: false })
    }, effectivePollMs)
    return () => window.clearInterval(id)
  }, [effectivePollMs, scopedExecutions.length])

  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== 'visible') return
      void fetchAllRef.current({ refreshBroker: false })
    }
    window.addEventListener('focus', onResume)
    document.addEventListener('visibilitychange', onResume)
    return () => {
      window.removeEventListener('focus', onResume)
      document.removeEventListener('visibilitychange', onResume)
    }
  }, [])

  if (!scopedExecutions.length) {
    return (
      <div className="am-positions-empty">
        {executions.length
          ? 'No linked execution for this symbol yet.'
          : 'No linked execution yet — order details will appear after deploy.'}
      </div>
    )
  }

  if (loading && !rows.length) {
    return <div className="am-positions-empty">Loading positions…</div>
  }

  if (error) {
    return (
      <div className="am-positions-empty">
        {error}
        <button
          type="button"
          className="am-positions-retry"
          onClick={() => { void fetchAll({ refreshBroker: isEtoro, force: true }) }}
        >
          Retry
        </button>
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className="am-positions-empty">
        No open positions for this thread yet.
        <button
          type="button"
          className="am-positions-retry"
          onClick={() => { void fetchAll({ refreshBroker: isEtoro, force: true }) }}
        >
          Refresh
        </button>
      </div>
    )
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
