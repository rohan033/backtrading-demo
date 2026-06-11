import type { StrategyTableRow } from '../components/StrategiesTable'
import type { ExecutionLike } from './groupExecutionsBySymbol'

export function executionToStrategyRow(execution: ExecutionLike): StrategyTableRow {
  const engineStatus = String(execution.data_plane_status || execution.status || 'unknown').toLowerCase()
  const isStoppable = ['running', 'starting', 'stale'].includes(engineStatus)

  return {
    id: execution.executor_id,
    name: execution.label || execution.symbol || execution.strategy_name || 'Strategy',
    symbol: execution.symbol || '—',
    status: engineStatus,
    createdAt: execution.created_at,
    scheduledFor: execution.scheduled_start_at || null,
    pnl: 0,
    inPosition: Boolean(execution.is_in_position),
    isLive: isStoppable,
    isScheduled: engineStatus === 'scheduled',
    logFile: execution.log_file || null,
    accountEnv: execution.account_env || null,
    source: execution.source_id || null,
  }
}

export function executionsToStrategyRows(executions: ExecutionLike[]): StrategyTableRow[] {
  return executions.map(executionToStrategyRow)
}
