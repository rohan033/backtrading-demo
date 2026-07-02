const AGENT_MONITOR_WS = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws/agent/monitor`

export type AgentMonitorJobState = 'running' | 'waiting_agent' | 'stopped'

export type AgentMonitorStatus = {
  type?: 'monitor_status'
  thread_id?: string
  active: boolean
  completed?: boolean
  client_mode?: boolean
  queue_size: number
  queue_max_items?: number
  queue_max_age_sec?: number
  queue_started_at?: number | null
  flush_at?: number | null
  next_poll_at?: number | null
  poll_interval_sec?: number
  flushing?: boolean
  job_state?: AgentMonitorJobState
  monitor_state?: string
  focus_key?: string
  last_poll_at?: number
  last_flush_at?: number
}

export async function getAgentMonitorStatus(threadId: string): Promise<AgentMonitorStatus> {
  const res = await fetch(`/api/control/agent/monitor/threads/${encodeURIComponent(threadId)}/status`)
  if (!res.ok) {
    throw new Error(`Failed to read monitor status (${res.status})`)
  }
  const json = (await res.json()) as { data?: AgentMonitorStatus }
  return json.data || { active: false, queue_size: 0 }
}

export async function startAgentMonitor(threadId: string): Promise<AgentMonitorStatus> {
  const res = await fetch(`/api/control/agent/monitor/threads/${encodeURIComponent(threadId)}/start`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`Failed to start monitor (${res.status})`)
  }
  const json = (await res.json()) as { data?: AgentMonitorStatus }
  return json.data || { active: false, queue_size: 0 }
}

export async function stopAgentMonitor(threadId: string): Promise<AgentMonitorStatus> {
  const res = await fetch(`/api/control/agent/monitor/threads/${encodeURIComponent(threadId)}/stop`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`Failed to stop monitor (${res.status})`)
  }
  const json = (await res.json()) as { data?: AgentMonitorStatus }
  return json.data || { active: false, queue_size: 0 }
}

export async function flushClientMonitor(
  threadId: string,
  context: Record<string, unknown>,
  options: {
    webNewsOnly?: boolean
    executionDecision?: boolean
    instructions?: string
    interactionMode?: 'ask' | 'execute'
  } = {},
): Promise<AgentMonitorStatus> {
  const res = await fetch(
    `/api/control/agent/monitor/threads/${encodeURIComponent(threadId)}/flush-client`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context,
        web_news_only: Boolean(options.webNewsOnly),
        execution_decision: Boolean(options.executionDecision),
        instructions: options.instructions,
        interaction_mode: options.interactionMode,
      }),
    },
  )
  if (!res.ok) {
    throw new Error(`Failed to flush client monitor (${res.status})`)
  }
  const json = (await res.json()) as { data?: AgentMonitorStatus }
  return json.data || { active: true, queue_size: 0, client_mode: true }
}

export { AGENT_MONITOR_WS }
