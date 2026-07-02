import { useMemo } from 'react'

import { useAgentMonitorStatus } from '@/hooks/useAgentMonitorStatus'
import type { AgentMonitorJobState, AgentMonitorStatus } from '@/lib/agentMonitor'
import {
  MONITOR_INTERVAL_MINUTES_OPTIONS,
  type MonitorIntervalMinutes,
} from '@/lib/agentMonitorControl'

type Props = {
  threadId: string
  enabled?: boolean
  liveStatus?: AgentMonitorStatus | null
  monitorUserEnabled?: boolean
  monitorCompleted?: boolean
  hasWatchTarget?: boolean
  watchLabel?: string | null
  intervalMinutes?: MonitorIntervalMinutes
  onIntervalChange?: (minutes: MonitorIntervalMinutes) => void
  onStart?: () => void
  onStop?: () => void
  onSendNow?: () => void
  sendingNow?: boolean
}

function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function jobStateLabel(state: AgentMonitorJobState | undefined, completed?: boolean): string {
  if (completed) return 'Stopped (trade complete)'
  if (state === 'waiting_agent') return 'Waiting for agent'
  if (state === 'running') return 'Running'
  return 'Stopped'
}

function shortThreadId(threadId: string): string {
  if (threadId.length <= 16) return threadId
  return `${threadId.slice(0, 8)}…${threadId.slice(-4)}`
}

export default function AgentMonitorQueueStatus({
  threadId,
  enabled = true,
  liveStatus = null,
  monitorUserEnabled = false,
  monitorCompleted = false,
  hasWatchTarget = false,
  watchLabel = null,
  intervalMinutes = 10,
  onIntervalChange,
  onStart,
  onStop,
  onSendNow,
  sendingNow = false,
}: Props) {
  const { status: polledStatus, clock } = useAgentMonitorStatus(threadId, enabled, {
    poll: enabled && !monitorUserEnabled,
    tick: enabled,
  })
  const status = liveStatus ?? polledStatus

  const view = useMemo(() => {
    const intervalLabel = `${intervalMinutes}m batch`

    if (!status) {
      return {
        queueSize: 0,
        queueMax: 100,
        fillPct: 0,
        jobState: 'stopped' as AgentMonitorJobState,
        jobLabel: 'Loading…',
        triggerText: 'Client monitor',
        threadLabel: shortThreadId(threadId),
        title: 'Client monitor',
        countLabel: intervalLabel,
      }
    }

    const queueMax = status.client_mode ? 1 : (status.queue_max_items || 100)
    const queueSize = status.client_mode ? 0 : (status.queue_size || 0)
    const maxAgeSec = status.queue_max_age_sec || intervalMinutes * 60
    const nowSec = clock / 1000

    const countPct = status.client_mode
      ? 0
      : queueMax > 0
        ? Math.min(100, (queueSize / queueMax) * 100)
        : 0
    const agePct =
      status.client_mode && status.flush_at && status.queue_started_at && monitorUserEnabled
        ? (() => {
          const windowSec = Math.max(1, status.flush_at - status.queue_started_at)
          const elapsed = Math.max(0, nowSec - status.queue_started_at)
          return Math.min(100, (elapsed / windowSec) * 100)
        })()
        : status.queue_started_at && monitorUserEnabled
          ? Math.min(100, ((nowSec - status.queue_started_at) / maxAgeSec) * 100)
          : 0
    const fillPct = Math.max(countPct, agePct)

    const flushInSec = status.flush_at ? status.flush_at - nowSec : null
    const nextPollInSec = status.next_poll_at ? status.next_poll_at - nowSec : null

    let triggerText = 'Monitor idle'
    if (monitorCompleted) {
      triggerText = 'Send a message to restart monitoring after trade close'
    } else if (!hasWatchTarget) {
      triggerText = 'Pick or mention a symbol to watch — then Start monitoring'
    } else if (!monitorUserEnabled) {
      triggerText = watchLabel
        ? `Start monitoring ${watchLabel} — agent decides when/how to enter`
        : 'Start monitoring — agent decides when/how to enter'
    } else if (status.job_state === 'waiting_agent') {
      triggerText = 'Batch sent — agent is processing live context'
    } else if (status.client_mode) {
      if (!status.active) {
        triggerText = 'Client monitor not running for this thread'
      } else if (flushInSec != null && flushInSec > 0) {
        triggerText = `Next agent batch in ${formatCountdown(flushInSec)}`
      } else if (status.flushing) {
        triggerText = 'Sending consolidated live context to agent…'
      } else {
        triggerText = 'Preparing next agent batch…'
      }
    } else if (!status.active) {
      triggerText = 'Background job not running for this thread'
    } else if (queueSize > 0) {
      const ageText = flushInSec != null ? formatCountdown(flushInSec) : formatCountdown(maxAgeSec)
      triggerText = `Agent batch at ${queueMax} events or in ${ageText}`
    } else if (nextPollInSec != null && nextPollInSec > 0) {
      triggerText = `Collecting context · next poll in ${formatCountdown(nextPollInSec)}`
    } else {
      triggerText = 'Collecting market context on next poll'
    }

    const jobState: AgentMonitorJobState = status.job_state
      || (status.active && monitorUserEnabled ? 'running' : 'stopped')

    return {
      queueSize,
      queueMax,
      fillPct,
      jobState,
      jobLabel: jobStateLabel(jobState, monitorCompleted),
      triggerText,
      threadLabel: shortThreadId(status.thread_id || threadId),
      title: status.client_mode ? 'Client monitor' : 'Background monitor',
      countLabel: status.client_mode ? intervalLabel : `${queueSize}/${queueMax}`,
    }
  }, [
    clock,
    enabled,
    hasWatchTarget,
    intervalMinutes,
    monitorCompleted,
    monitorUserEnabled,
    status,
    threadId,
    watchLabel,
  ])

  const stateClass =
    view.jobState === 'waiting_agent'
      ? 'am-monitor-status__badge--waiting'
      : view.jobState === 'running'
        ? 'am-monitor-status__badge--running'
        : 'am-monitor-status__badge--stopped'

  const canStart = hasWatchTarget && !monitorCompleted && !monitorUserEnabled
  const canStop = monitorUserEnabled && !monitorCompleted
  const canSendNow = Boolean(onSendNow) && hasWatchTarget && !monitorCompleted && !sendingNow

  return (
    <footer className="am-monitor-status" aria-live="polite">
      <div className="am-monitor-status__row">
        <span className="am-monitor-status__title">{view.title}</span>
        <div className="am-monitor-status__actions">
          <span className={`am-monitor-status__badge ${stateClass}`}>{view.jobLabel}</span>
          {canSendNow ? (
            <button
              type="button"
              className="am-monitor-status__toggle am-monitor-status__toggle--send"
              onClick={onSendNow}
              disabled={sendingNow}
              title="Send live context to agent now"
            >
              {sendingNow ? 'Sending…' : 'Send now'}
            </button>
          ) : null}
          {canStop ? (
            <button
              type="button"
              className="am-monitor-status__toggle am-monitor-status__toggle--stop"
              onClick={onStop}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="am-monitor-status__toggle am-monitor-status__toggle--start"
              disabled={!canStart}
              onClick={onStart}
            >
              Start
            </button>
          )}
        </div>
      </div>
      <div className="am-monitor-status__row am-monitor-status__row--meta">
        <span className="am-monitor-status__id" title={threadId}>
          Job {view.threadLabel}
        </span>
        <label className="am-monitor-status__interval">
          <span>Every</span>
          <select
            value={intervalMinutes}
            disabled={!onIntervalChange}
            onChange={event => {
              const next = Number(event.target.value) as MonitorIntervalMinutes
              onIntervalChange?.(next)
            }}
            aria-label="Monitor batch interval"
          >
            {MONITOR_INTERVAL_MINUTES_OPTIONS.map(minutes => (
              <option key={minutes} value={minutes}>{minutes} min</option>
            ))}
          </select>
        </label>
        <span className="am-monitor-status__count">{view.countLabel}</span>
      </div>
      <div
        className={`am-monitor-status__bar${view.jobState === 'waiting_agent' ? ' am-monitor-status__bar--pulse' : ''}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={view.queueMax}
        aria-valuenow={view.queueSize}
        aria-label={`Monitor queue ${view.queueSize} of ${view.queueMax}`}
      >
        <span className="am-monitor-status__fill" style={{ width: `${view.fillPct}%` }} />
      </div>
      <p className="am-monitor-status__hint">{view.triggerText}</p>
    </footer>
  )
}
