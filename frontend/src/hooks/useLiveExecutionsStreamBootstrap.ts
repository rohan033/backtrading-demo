import { useEffect, useRef } from 'react'

import { repairControlledExecution } from '../ExecutionWorkspace'

type LiveExecutionRef = {
  executor_id: string
  ws_url?: string
  data_plane_status?: string
}

type Options = {
  refreshControlledExecutions: () => Promise<void>
  refreshExecutions: () => Promise<void>
}

function isLiveExecution(execution: LiveExecutionRef): boolean {
  return Boolean(execution?.ws_url)
    && ['running', 'starting'].includes(String(execution.data_plane_status || '').toLowerCase())
}

export function useLiveExecutionsStreamBootstrap(
  executions: LiveExecutionRef[],
  { refreshControlledExecutions, refreshExecutions }: Options,
) {
  const attemptedRef = useRef(new Set<string>())

  useEffect(() => {
    const live = executions.filter(isLiveExecution)
    const pending = live.filter(execution => !attemptedRef.current.has(execution.executor_id))
    if (!pending.length) return undefined

    let cancelled = false

    ;(async () => {
      for (const execution of pending) {
        if (cancelled) break
        attemptedRef.current.add(execution.executor_id)
        try {
          await repairControlledExecution(execution.executor_id)
        } catch {
          // Ignore per-execution repair failures; detail page can retry manually.
        }
      }
      if (!cancelled) {
        await refreshControlledExecutions()
        await refreshExecutions()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [executions, refreshControlledExecutions, refreshExecutions])
}
