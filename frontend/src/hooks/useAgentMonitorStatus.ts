import { useEffect, useState } from 'react'

import { getAgentMonitorStatus, type AgentMonitorStatus } from '@/lib/agentMonitor'

const POLL_MS = 2_000

type Options = {
  /** Poll REST status from the server. */
  poll?: boolean
  /** Tick the local clock for countdown UI (independent of polling). */
  tick?: boolean
}

export function useAgentMonitorStatus(
  threadId: string | null | undefined,
  enabled = true,
  options: Options = {},
) {
  const poll = options.poll ?? enabled
  const tick = options.tick ?? enabled
  const [status, setStatus] = useState<AgentMonitorStatus | null>(null)
  const [clock, setClock] = useState(() => Date.now())

  useEffect(() => {
    if (!tick) return undefined
    const id = window.setInterval(() => setClock(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [tick])

  useEffect(() => {
    if (!poll || !threadId) {
      if (!poll) return undefined
      setStatus(null)
      return undefined
    }

    let cancelled = false
    let pollTimer: number | null = null

    const refresh = async () => {
      try {
        const next = await getAgentMonitorStatus(threadId)
        if (!cancelled) setStatus(next)
      } catch {
        // keep last known status
      }
    }

    void refresh()
    pollTimer = window.setInterval(() => void refresh(), POLL_MS)

    return () => {
      cancelled = true
      if (pollTimer != null) window.clearInterval(pollTimer)
    }
  }, [poll, threadId])

  return { status, clock }
}
