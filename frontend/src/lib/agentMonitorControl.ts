const RUNNING_STATUSES = new Set(['running', 'active', 'starting', 'stale'])

/** Action statuses that describe deploy workflow, not live engine state. */
const WORKFLOW_ACTION_STATUSES = new Set([
  'saved',
  'open',
  'pending',
  'deployed',
  'closed',
  'complete',
  'completed',
])

export function isAgentStrategyRunning(status: string | null | undefined): boolean {
  const normalized = String(status || '').trim().toLowerCase()
  return RUNNING_STATUSES.has(normalized)
}

/** Prefer live engine / data-plane status over stale action workflow status (e.g. saved). */
export function resolveExecutionRuntimeStatus(
  engineStatus?: string | null,
  actionStatus?: string | null,
  dataPlaneStatus?: string | null,
): string | null {
  const live = String(dataPlaneStatus || engineStatus || '').trim()
  const liveNorm = live.toLowerCase()
  if (live && (isAgentStrategyRunning(liveNorm) || liveNorm === 'scheduled')) {
    return live
  }

  const action = String(actionStatus || '').trim()
  const actionNorm = action.toLowerCase()
  if (action && isAgentStrategyRunning(actionNorm)) {
    return action
  }

  if (live && !WORKFLOW_ACTION_STATUSES.has(liveNorm)) {
    return live
  }

  if (engineStatus && isAgentStrategyRunning(engineStatus)) {
    return engineStatus
  }

  return action || engineStatus || dataPlaneStatus || null
}

export function readMonitorUserEnabled(metadata: Record<string, unknown> | null | undefined): boolean {
  return Boolean(metadata?.monitor_user_enabled)
}

export const MONITOR_INTERVAL_MINUTES_OPTIONS = [1, 2, 5, 10, 15, 30] as const
export type MonitorIntervalMinutes = (typeof MONITOR_INTERVAL_MINUTES_OPTIONS)[number]

export const DEFAULT_MONITOR_INTERVAL_MINUTES: MonitorIntervalMinutes = 10

export function readMonitorIntervalMinutes(
  metadata: Record<string, unknown> | null | undefined,
): MonitorIntervalMinutes {
  const value = Number(metadata?.monitor_interval_minutes)
  if (MONITOR_INTERVAL_MINUTES_OPTIONS.includes(value as MonitorIntervalMinutes)) {
    return value as MonitorIntervalMinutes
  }
  return DEFAULT_MONITOR_INTERVAL_MINUTES
}

export function monitorIntervalMs(minutes: MonitorIntervalMinutes): number {
  return minutes * 60_000
}

/** Monitor can run while researching — only block after trade_complete. */
export function canRunAgentMonitor(options: {
  monitorCompleted: boolean
  hasWatchTarget: boolean
}): boolean {
  return !options.monitorCompleted && options.hasWatchTarget
}
