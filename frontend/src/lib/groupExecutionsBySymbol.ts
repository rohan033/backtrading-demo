export type ExecutionLike = {
  executor_id: string
  symbol?: string | null
  broker?: string | null
  label?: string | null
  strategy_name?: string | null
  data_plane_status?: string | null
  status?: string | null
  created_at?: string | null
  scheduled_start_at?: string | null
  is_in_position?: boolean | null
  log_file?: string | null
}

export type StockGroupSummary = {
  symbolKey: string
  symbol: string
  brokers: string[]
  strategyCount: number
  runningCount: number
  scheduledCount: number
  stoppedCount: number
  inPositionCount: number
  latestCreatedAt: string | null
  executionIds: string[]
}

export function normalizeSymbolKey(symbol: string | null | undefined): string {
  const value = String(symbol || '').trim()
  return value || 'unknown'
}

function engineStatus(execution: ExecutionLike): string {
  return String(execution.data_plane_status || execution.status || 'unknown').toLowerCase()
}

export function groupExecutionsBySymbol(executions: ExecutionLike[]): StockGroupSummary[] {
  const groups = new Map<string, StockGroupSummary>()

  for (const execution of executions) {
    const symbol = String(execution.symbol || '').trim() || 'Unknown'
    const symbolKey = normalizeSymbolKey(symbol)
    const status = engineStatus(execution)
    const isRunning = ['running', 'starting', 'stale'].includes(status)
    const isScheduled = status === 'scheduled'
    const broker = String(execution.broker || '').trim()

    const existing = groups.get(symbolKey) || {
      symbolKey,
      symbol,
      brokers: [],
      strategyCount: 0,
      runningCount: 0,
      scheduledCount: 0,
      stoppedCount: 0,
      inPositionCount: 0,
      latestCreatedAt: null,
      executionIds: [],
    }

    existing.strategyCount += 1
    if (isRunning) existing.runningCount += 1
    else if (isScheduled) existing.scheduledCount += 1
    else existing.stoppedCount += 1
    if (execution.is_in_position) existing.inPositionCount += 1
    if (broker && !existing.brokers.includes(broker)) existing.brokers.push(broker)
    existing.executionIds.push(execution.executor_id)

    const createdAt = execution.created_at || null
    if (createdAt && (!existing.latestCreatedAt || createdAt > existing.latestCreatedAt)) {
      existing.latestCreatedAt = createdAt
    }

    groups.set(symbolKey, existing)
  }

  return [...groups.values()].sort((a, b) => {
    const aTime = a.latestCreatedAt || ''
    const bTime = b.latestCreatedAt || ''
    return bTime.localeCompare(aTime)
  })
}

export function filterExecutionsBySymbolKey(
  executions: ExecutionLike[],
  symbolKey: string,
): ExecutionLike[] {
  const needle = normalizeSymbolKey(symbolKey)
  return executions.filter(execution => normalizeSymbolKey(execution.symbol) === needle)
}
