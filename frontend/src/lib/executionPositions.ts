const CONTROL_API = '/api/control'

export type ExecutionPositionRow = {
  position_id: string | number
  order_id?: string | number | null
  state?: string
  remaining_units?: number | null
  instrument_id?: string | number | null
  position?: Record<string, unknown>
  source: 'control' | 'order' | 'live' | 'etoro'
  closable: boolean
  statusLabel?: string
}

type LoadExecutionPositionsParams = {
  executorId: string
  liveApi?: string | null
  broker?: string | null
  accountEnv?: string | null
  symbol?: string | null
  token?: string | number | null
}

function normalizeState(state: unknown): string {
  return String(state || '').trim().toLowerCase()
}

function positionIdFromRow(row: Record<string, unknown>): string | number | null {
  const nested = (row.position || {}) as Record<string, unknown>
  return (
    row.position_id
    ?? row.positionId
    ?? row.positionID
    ?? nested.positionId
    ?? nested.positionID
    ?? nested.position_id
    ?? null
  )
}

function unitsFromRow(row: Record<string, unknown>): number | null {
  const nested = (row.position || {}) as Record<string, unknown>
  const units = Number(
    row.remaining_units
    ?? row.remainingUnits
    ?? nested.remainingUnits
    ?? nested.units
    ?? nested.Units
    ?? row.quantity
    ?? null,
  )
  return Number.isFinite(units) ? units : null
}

function rowsFromLookupExecutions(
  lookup: Record<string, unknown> | null | undefined,
  orderId: string | number | null | undefined,
): ExecutionPositionRow[] {
  if (!lookup || typeof lookup !== 'object') return []
  const executions = (lookup.positionExecutions || []) as Record<string, unknown>[]
  const rows: ExecutionPositionRow[] = []

  for (const execution of executions) {
    const positionId = positionIdFromRow(execution)
    if (positionId == null) continue
    rows.push({
      position_id: positionId,
      order_id: orderId ?? lookup.orderId ?? null,
      state: normalizeState(execution.state) || 'open',
      remaining_units: unitsFromRow(execution),
      instrument_id: execution.instrumentId ?? execution.instrumentID ?? null,
      position: execution,
      source: 'order',
      closable: true,
    })
  }
  return rows
}

function normalizeControlRow(row: Record<string, unknown>): ExecutionPositionRow | null {
  const positionId = positionIdFromRow(row)
  if (positionId == null) return null
  const nested = (row.position || {}) as Record<string, unknown>
  return {
    position_id: positionId,
    order_id: row.order_id ?? null,
    state: normalizeState(row.state || nested.state),
    remaining_units: unitsFromRow(row),
    instrument_id: row.instrument_id ?? nested.instrumentId ?? nested.instrumentID ?? null,
    position: nested,
    source: 'control',
    closable: true,
  }
}

function normalizeLiveRow(row: Record<string, unknown>): ExecutionPositionRow {
  const orderId = row.order_id ?? row.orderId ?? 'unknown'
  return {
    position_id: `live-order:${orderId}`,
    order_id: orderId,
    state: 'tracked',
    remaining_units: unitsFromRow(row),
    position: {
      openRate: row.entry_price,
      avgPrice: row.entry_price,
      symbol: row.symbol,
      reason: row.reason,
      status: row.status,
    },
    source: 'live',
    closable: false,
    statusLabel: 'Tracked',
  }
}

function normalizeEtoroRawRow(row: Record<string, unknown>, symbol?: string | null, token?: string | number | null): ExecutionPositionRow | null {
  const positionId = positionIdFromRow(row)
  if (positionId == null) return null

  const instrumentId = row.instrumentID ?? row.instrumentId ?? row.instrument_id
  if (token != null && instrumentId != null && String(instrumentId) !== String(token)) return null

  const rowSymbol = String(row.symbol || row.Symbol || row.instrumentDisplayName || '').trim().toUpperCase()
  if (symbol && rowSymbol && rowSymbol !== String(symbol).trim().toUpperCase()) return null

  return {
    position_id: positionId,
    state: 'open',
    remaining_units: unitsFromRow(row),
    instrument_id: instrumentId ?? null,
    position: row,
    source: 'etoro',
    closable: true,
  }
}

function dedupePositions(rows: ExecutionPositionRow[]): ExecutionPositionRow[] {
  const byKey = new Map<string, ExecutionPositionRow>()
  const priority = { control: 4, order: 3, etoro: 2, live: 1 }

  for (const row of rows) {
    const key = String(row.position_id)
    const existing = byKey.get(key)
    if (!existing || priority[row.source] > priority[existing.source]) {
      byKey.set(key, row)
    }
  }
  return [...byKey.values()]
}

export function isOpenExecutionPosition(row: ExecutionPositionRow): boolean {
  const state = normalizeState(row.state || row.position?.state)
  if (state === 'closed') return false
  const units = unitsFromRow(row)
  if (units != null && units <= 0 && state === 'closed') return false
  return true
}

export async function loadExecutionPositions({
  executorId,
  liveApi,
  broker,
  accountEnv,
  symbol,
  token,
}: LoadExecutionPositionsParams): Promise<ExecutionPositionRow[]> {
  if (!executorId) return []

  const rows: ExecutionPositionRow[] = []

  try {
    const res = await fetch(`${CONTROL_API}/executions/${encodeURIComponent(executorId)}/positions`)
    const data = await res.json()
    if (data.status) {
      for (const row of (data.data || []) as Record<string, unknown>[]) {
        const normalized = normalizeControlRow(row)
        if (normalized) rows.push(normalized)
      }
    }
  } catch {
    // fall through to other sources
  }

  try {
    const params = new URLSearchParams({ executor_id: executorId })
    const res = await fetch(`${CONTROL_API}/orders?${params}`)
    const data = await res.json()
    if (data.status) {
      for (const order of Object.values((data.data || {}) as Record<string, Record<string, unknown>>)) {
        for (const row of (order.positions || []) as Record<string, unknown>[]) {
          const normalized = normalizeControlRow({
            ...row,
            order_id: order.order_id,
            executor_id: order.executor_id,
          })
          if (normalized) rows.push(normalized)
        }
        rows.push(...rowsFromLookupExecutions(order.lookup as Record<string, unknown>, order.order_id as string))
      }
    }
  } catch {
    // ignore
  }

  const apiBase = String(liveApi || '').trim().replace(/\/$/, '')
  if (apiBase) {
    try {
      const res = await fetch(`${apiBase}/positions`)
      const data = await res.json()
      if (data.status) {
        for (const row of (data.data || []) as Record<string, unknown>[]) {
          if (String(row.executor_id || '') !== executorId) continue
          rows.push(normalizeLiveRow(row))
        }
      }
    } catch {
      // ignore
    }
  }

  if ((broker || '').toLowerCase() === 'etoro') {
    try {
      const env = (accountEnv || 'demo').toLowerCase() === 'live' ? 'live' : 'demo'
      const res = await fetch(`${CONTROL_API}/etoro/positions?account_env=${encodeURIComponent(env)}`)
      const data = await res.json()
      if (data.status) {
        for (const row of (data.raw || []) as Record<string, unknown>[]) {
          const normalized = normalizeEtoroRawRow(row, symbol, token)
          if (normalized) rows.push(normalized)
        }
      }
    } catch {
      // ignore
    }
  }

  return dedupePositions(rows).filter(isOpenExecutionPosition)
}

export async function closeExecutionPosition(
  executorId: string,
  row: ExecutionPositionRow,
  units: number | null = null,
): Promise<void> {
  if (!row.closable) {
    throw new Error('This tracked position cannot be closed on the broker yet.')
  }

  const res = await fetch(
    `${CONTROL_API}/executions/${encodeURIComponent(executorId)}/positions/${encodeURIComponent(String(row.position_id))}/close`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        units,
        instrument_id: row.instrument_id || null,
      }),
    },
  )
  const data = await res.json()
  if (!res.ok || !data.status) {
    throw new Error(data.detail || data.message || 'Failed to close position')
  }
}
