import { useCallback, useEffect, useMemo, useState } from 'react'

import { computeLivePnl, isOpenPosition } from '../lib/positionPnl'

export type ExecutionPnlSnapshot = {
  totalPnl: number | null
  openCount: number
  loading: boolean
}

type ExecutionRef = {
  executor_id: string
}

type PositionRow = Parameters<typeof computeLivePnl>[0]

export function useExecutionPositionsPnl(
  executions: ExecutionRef[],
  livePriceByExecutor: Record<string, number | null | undefined>,
  pollMs = 10_000,
): Record<string, ExecutionPnlSnapshot> {
  const [openByExecutor, setOpenByExecutor] = useState<Record<string, PositionRow[]>>({})
  const [loading, setLoading] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!executions.length) {
      setOpenByExecutor({})
      return
    }

    setLoading(true)
    try {
      const entries = await Promise.all(
        executions.map(async execution => {
          const executorId = execution.executor_id
          try {
            const res = await fetch(`/api/control/executions/${encodeURIComponent(executorId)}/positions`)
            const data = await res.json()
            const positions = data.status ? (data.data || []) : []
            const open = positions.filter((p: PositionRow & { state?: string; position_id?: string | number; position?: { state?: string } }) =>
              isOpenPosition(p),
            )
            return [executorId, open] as const
          } catch {
            return [executorId, []] as const
          }
        }),
      )
      setOpenByExecutor(Object.fromEntries(entries))
    } finally {
      setLoading(false)
    }
  }, [executions])

  useEffect(() => {
    fetchAll()
    const id = window.setInterval(fetchAll, pollMs)
    return () => window.clearInterval(id)
  }, [fetchAll, pollMs])

  return useMemo(() => {
    const snapshots: Record<string, ExecutionPnlSnapshot> = {}
    for (const execution of executions) {
      const executorId = execution.executor_id
      const open = openByExecutor[executorId] || []
      const livePrice = livePriceByExecutor[executorId]
      const livePnls = open
        .map(position => computeLivePnl(position, livePrice))
        .filter(Boolean)
      const totalPnl = livePnls.length
        ? livePnls.reduce((sum, item) => sum + (item?.pnl ?? 0), 0)
        : null

      snapshots[executorId] = {
        totalPnl,
        openCount: open.length,
        loading,
      }
    }
    return snapshots
  }, [executions, openByExecutor, livePriceByExecutor, loading])
}
