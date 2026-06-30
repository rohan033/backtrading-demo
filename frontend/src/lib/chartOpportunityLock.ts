import { EXECUTION_SOURCE_CHART_OPPORTUNITY } from './executionSources'

export const CHART_OPPORTUNITY_LOCK_KEY = 'home-chart-opportunity-lock'

export type ChartOpportunityLock = {
  executionId: string
  symbol: string
  token: string
  broker: string
  accountEnv: string
  signalId: string
  createdAt: number
}

type ExecutionRow = {
  executor_id?: string
  symbol?: string
  token?: string
  broker?: string
  account_env?: string
  data_plane_status?: string
  source_id?: string
  engine?: {
    metadata?: {
      source_id?: string
      execution_config?: {
        source_id?: string
      }
    }
  }
}

const ACTIVE_STATUSES = new Set(['running', 'starting', 'scheduled', 'deploying'])

function readSourceId(row: ExecutionRow): string | null {
  return (
    row.source_id
    || row.engine?.metadata?.source_id
    || row.engine?.metadata?.execution_config?.source_id
    || null
  )
}

export function readChartOpportunityLock(): ChartOpportunityLock | null {
  try {
    const raw = localStorage.getItem(CHART_OPPORTUNITY_LOCK_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ChartOpportunityLock
    if (!parsed?.executionId) return null
    return parsed
  } catch {
    return null
  }
}

export function writeChartOpportunityLock(lock: ChartOpportunityLock): void {
  try {
    localStorage.setItem(CHART_OPPORTUNITY_LOCK_KEY, JSON.stringify(lock))
  } catch {
    // ignore storage errors
  }
}

export function clearChartOpportunityLock(): void {
  try {
    localStorage.removeItem(CHART_OPPORTUNITY_LOCK_KEY)
  } catch {
    // ignore storage errors
  }
}

export async function fetchChartOpportunityBlockState(
  broker: string,
  accountEnv: string,
  symbol: string,
): Promise<{
  blocked: boolean
  reason?: string
  executionId?: string
  status?: string
}> {
  const lock = readChartOpportunityLock()
  let rows: ExecutionRow[] = []

  try {
    const res = await fetch('/api/control/executions')
    if (res.ok) {
      const payload = await res.json()
      rows = Array.isArray(payload?.data) ? payload.data : []
    }
  } catch {
    return { blocked: Boolean(lock), reason: lock ? 'lock_pending' : undefined, executionId: lock?.executionId }
  }

  const activeAuto = rows.filter(row => {
    const status = String(row.data_plane_status || '').toLowerCase()
    if (!ACTIVE_STATUSES.has(status)) return false
    return readSourceId(row) === EXECUTION_SOURCE_CHART_OPPORTUNITY
  })

  if (activeAuto.length) {
    const row = activeAuto[0]
    return {
      blocked: true,
      reason: 'active_auto_strategy',
      executionId: row.executor_id,
      status: row.data_plane_status,
    }
  }

  if (lock) {
    const matched = rows.find(row => row.executor_id === lock.executionId)
    const status = String(matched?.data_plane_status || '').toLowerCase()
    if (!matched || !ACTIVE_STATUSES.has(status)) {
      clearChartOpportunityLock()
      return { blocked: false }
    }
    return {
      blocked: true,
      reason: 'pending_lock',
      executionId: lock.executionId,
      status: matched.data_plane_status,
    }
  }

  const activeSameSymbol = rows.find(row => {
    const status = String(row.data_plane_status || '').toLowerCase()
    return (
      ACTIVE_STATUSES.has(status)
      && row.symbol === symbol
      && row.broker === broker
      && (row.account_env || 'demo') === accountEnv
      && readSourceId(row) === EXECUTION_SOURCE_CHART_OPPORTUNITY
    )
  })

  if (activeSameSymbol) {
    return {
      blocked: true,
      reason: 'symbol_auto_strategy',
      executionId: activeSameSymbol.executor_id,
      status: activeSameSymbol.data_plane_status,
    }
  }

  return { blocked: false }
}
