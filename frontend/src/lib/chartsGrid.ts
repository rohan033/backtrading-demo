import type { ExecutionPnlSnapshot } from '../hooks/useExecutionPositionsPnl'

export type ChartSortKey =
  | 'profit-desc'
  | 'profit-asc'
  | 'symbol-asc'
  | 'symbol-desc'
  | 'created-desc'
  | 'created-asc'

export type ChartFilterKey = 'all' | 'in-position' | 'profitable' | 'streaming' | 'issues'

export type ChartEnvFilter = 'all' | 'demo' | 'live'

export type ChartColumnCount = 3 | 4

export const CHART_ENV_FILTER_OPTIONS: { id: ChartEnvFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'demo', label: 'Demo' },
  { id: 'live', label: 'Live' },
]

export function normalizeAccountEnv(value: string | null | undefined): 'demo' | 'live' {
  return String(value || 'live').toLowerCase() === 'demo' ? 'demo' : 'live'
}

export function filterExecutionsByEnv<T extends { account_env?: string | null }>(
  executions: T[],
  envFilter: ChartEnvFilter,
): T[] {
  if (envFilter === 'all') return executions
  return executions.filter(execution => normalizeAccountEnv(execution.account_env) === envFilter)
}

export const CHART_SORT_OPTIONS: { id: ChartSortKey; label: string }[] = [
  { id: 'profit-desc', label: 'Profit (high → low)' },
  { id: 'profit-asc', label: 'Profit (low → high)' },
  { id: 'symbol-asc', label: 'Symbol (A → Z)' },
  { id: 'symbol-desc', label: 'Symbol (Z → A)' },
  { id: 'created-desc', label: 'Newest first' },
  { id: 'created-asc', label: 'Oldest first' },
]

export const CHART_FILTER_OPTIONS: { id: ChartFilterKey; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'in-position', label: 'In position' },
  { id: 'profitable', label: 'Profitable' },
  { id: 'streaming', label: 'Live prices' },
  { id: 'issues', label: 'Stream issues' },
]

type ExecutionRow = {
  executor_id: string
  symbol?: string
  created_at?: string | null
}

type StreamStatus = {
  status: string
}

export function filterExecutions<T extends ExecutionRow>(
  executions: T[],
  filterKey: ChartFilterKey,
  pnlByExecutor: Record<string, ExecutionPnlSnapshot | undefined>,
  streamStatusByExecutor: Record<string, StreamStatus | undefined>,
): T[] {
  if (filterKey === 'all') return executions

  return executions.filter(execution => {
    const pnl = pnlByExecutor[execution.executor_id]
    const stream = streamStatusByExecutor[execution.executor_id]

    switch (filterKey) {
      case 'in-position':
        return (pnl?.openCount ?? 0) > 0
      case 'profitable':
        return pnl?.totalPnl != null && pnl.totalPnl > 0
      case 'streaming':
        return stream?.status === 'flowing'
      case 'issues':
        return stream != null && ['stale', 'no_ticks', 'disconnected', 'offline', 'connecting', 'waiting'].includes(stream.status)
      default:
        return true
    }
  })
}

function createdTimestamp(execution: ExecutionRow): number {
  const raw = execution.created_at
  if (!raw) return 0
  const ms = Date.parse(raw)
  return Number.isFinite(ms) ? ms : 0
}

export function sortExecutions<T extends ExecutionRow>(
  executions: T[],
  sortKey: ChartSortKey,
  pnlByExecutor: Record<string, ExecutionPnlSnapshot | undefined>,
): T[] {
  const sorted = [...executions]

  sorted.sort((a, b) => {
    switch (sortKey) {
      case 'profit-desc': {
        const aPnl = pnlByExecutor[a.executor_id]?.totalPnl ?? Number.NEGATIVE_INFINITY
        const bPnl = pnlByExecutor[b.executor_id]?.totalPnl ?? Number.NEGATIVE_INFINITY
        return bPnl - aPnl
      }
      case 'profit-asc': {
        const aPnl = pnlByExecutor[a.executor_id]?.totalPnl ?? Number.POSITIVE_INFINITY
        const bPnl = pnlByExecutor[b.executor_id]?.totalPnl ?? Number.POSITIVE_INFINITY
        return aPnl - bPnl
      }
      case 'symbol-asc':
        return String(a.symbol || '').localeCompare(String(b.symbol || ''))
      case 'symbol-desc':
        return String(b.symbol || '').localeCompare(String(a.symbol || ''))
      case 'created-desc':
        return createdTimestamp(b) - createdTimestamp(a)
      case 'created-asc':
        return createdTimestamp(a) - createdTimestamp(b)
      default:
        return 0
    }
  })

  return sorted
}

export function gridColumnClass(columns: ChartColumnCount): string {
  if (columns === 4) {
    return 'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-3'
  }
  return 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3'
}
