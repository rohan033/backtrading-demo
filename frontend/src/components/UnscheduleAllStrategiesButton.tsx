import { useCallback, useEffect, useState } from 'react'
import { CalendarOff } from 'lucide-react'

type ExecutionRow = {
  engine?: {
    status?: string
  }
  status?: string
}

function countScheduledExecutions(rows: ExecutionRow[]) {
  return rows.filter(row => {
    const status = String(row.engine?.status || row.status || '').toLowerCase()
    return status === 'scheduled'
  }).length
}

type UnscheduleAllStrategiesButtonProps = {
  onComplete?: () => void | Promise<void>
  className?: string
  alwaysShow?: boolean
  refreshIntervalMs?: number
}

export function UnscheduleAllStrategiesButton({
  onComplete,
  className = '',
  alwaysShow = false,
  refreshIntervalMs = 12_000,
}: UnscheduleAllStrategiesButtonProps) {
  const [scheduledCount, setScheduledCount] = useState(0)
  const [unscheduling, setUnscheduling] = useState(false)
  const [error, setError] = useState('')

  const refreshCount = useCallback(async () => {
    try {
      const res = await fetch('/api/control/executions')
      const payload = await res.json()
      if (!res.ok || !payload.status) return
      setScheduledCount(countScheduledExecutions(payload.data || []))
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

  const unscheduleAll = async () => {
    if (unscheduling || scheduledCount < 1) return

    const confirmed = window.confirm(
      `Unschedule all ${scheduledCount} scheduled strateg${scheduledCount === 1 ? 'y' : 'ies'}?`,
    )
    if (!confirmed) return

    setUnscheduling(true)
    setError('')
    try {
      const res = await fetch('/api/control/executions/bulk/unschedule', { method: 'POST' })
      const payload = await res.json()
      if (!res.ok || !payload.status) {
        throw new Error(payload.detail || payload.message || 'Failed to unschedule strategies')
      }
      await refreshCount()
      await onComplete?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to unschedule strategies')
    } finally {
      setUnscheduling(false)
    }
  }

  if (!alwaysShow && scheduledCount < 1 && !unscheduling) {
    return null
  }

  const disabled = unscheduling || scheduledCount < 1

  return (
    <div className={`flex flex-col items-end gap-1 ${className}`}>
      <button
        type="button"
        onClick={() => void unscheduleAll()}
        disabled={disabled}
        title={scheduledCount < 1 ? 'No strategies are scheduled' : 'Unschedule every scheduled strategy'}
        className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-45"
      >
        <CalendarOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        {unscheduling
          ? 'Unscheduling all…'
          : scheduledCount > 0
            ? `Unschedule all (${scheduledCount})`
            : 'Unschedule all'}
      </button>
      {error ? (
        <span className="max-w-[220px] text-right text-[10px] text-red-400">{error}</span>
      ) : null}
    </div>
  )
}
