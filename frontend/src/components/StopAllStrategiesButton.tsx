import { useCallback, useEffect, useState } from 'react'
import { Octagon } from 'lucide-react'

const STOPPABLE_STATUSES = new Set(['running', 'starting', 'stale'])

type ExecutionRow = {
  status?: string
  data_plane_status?: string
}

function countRunningExecutions(rows: ExecutionRow[]) {
  return rows.filter(row => {
    const status = String(row.data_plane_status || row.status || '').toLowerCase()
    return STOPPABLE_STATUSES.has(status)
  }).length
}

type StopAllStrategiesButtonProps = {
  onComplete?: () => void | Promise<void>
  className?: string
  /** When true, render even if nothing is running (disabled). */
  alwaysShow?: boolean
  refreshIntervalMs?: number
}

export function StopAllStrategiesButton({
  onComplete,
  className = '',
  alwaysShow = false,
  refreshIntervalMs = 12_000,
}: StopAllStrategiesButtonProps) {
  const [runningCount, setRunningCount] = useState(0)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState('')

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/control/executions')
      const payload = await res.json()
      if (!res.ok || !payload.status) return
      setRunningCount(countRunningExecutions(payload.data || []))
    } catch {
      // Keep last known count on transient fetch errors.
    }
  }, [])

  useEffect(() => {
    void refreshCount()
    const timer = window.setInterval(() => {
      void refreshCount()
    }, refreshIntervalMs)
    return () => window.clearInterval(timer)
  }, [refreshCount, refreshIntervalMs])

  const stopAll = async () => {
    if (stopping || runningCount < 1) return

    const confirmed = window.confirm(
      `Stop all ${runningCount} running strateg${runningCount === 1 ? 'y' : 'ies'}?`,
    )
    if (!confirmed) return

    setStopping(true)
    setError('')
    try {
      const res = await fetch('/api/control/executions/stop-all', { method: 'POST' })
      const payload = await res.json()
      if (!res.ok || !payload.status) {
        throw new Error(payload.detail || payload.message || 'Failed to stop strategies')
      }
      await refreshCount()
      await onComplete?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop strategies')
    } finally {
      setStopping(false)
    }
  }

  if (!alwaysShow && runningCount < 1 && !stopping) {
    return null
  }

  const disabled = stopping || runningCount < 1

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => void stopAll()}
        disabled={disabled}
        title={runningCount < 1 ? 'No strategies are running' : 'Stop every running strategy'}
        className="inline-flex items-center gap-1.5 rounded-md border border-red-500/45 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <Octagon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {stopping ? 'Stopping all…' : runningCount > 0 ? `Stop all (${runningCount})` : 'Stop all'}
      </button>
      {error ? (
        <span className="max-w-[220px] text-right text-[10px] text-red-400">{error}</span>
      ) : null}
    </div>
  )
}
