import { useEffect, useRef } from 'react'

import { isA2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'
import { AGENT_MONITOR_WS, getAgentMonitorStatus, startAgentMonitor, stopAgentMonitor } from '@/lib/agentMonitor'

type Params = {
  threadId: string
  symbol: string | null | undefined
  enabled?: boolean
  onAguiEvent: (event: Record<string, unknown>) => void
  onRunFinished?: () => void
  onMonitorStatus?: (status: Record<string, unknown>) => void
}

export function useAgentMonitorFeed({
  threadId,
  symbol,
  enabled = true,
  onAguiEvent,
  onRunFinished,
  onMonitorStatus,
}: Params) {
  const onAguiRef = useRef(onAguiEvent)
  const onRunFinishedRef = useRef(onRunFinished)
  const onMonitorStatusRef = useRef(onMonitorStatus)

  useEffect(() => {
    onAguiRef.current = onAguiEvent
  }, [onAguiEvent])

  useEffect(() => {
    onRunFinishedRef.current = onRunFinished
  }, [onRunFinished])

  useEffect(() => {
    onMonitorStatusRef.current = onMonitorStatus
  }, [onMonitorStatus])

  useEffect(() => {
    if (!enabled || !threadId || !symbol) return undefined

    let cancelled = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null

    const connect = () => {
      if (cancelled) return
      socket = new WebSocket(AGENT_MONITOR_WS)

      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'subscribe', thread_id: threadId }))
      }

      socket.onmessage = event => {
        try {
          const payload = JSON.parse(event.data) as Record<string, unknown>
          if (isA2uiSurfaceMessage(payload) || payload.type === 'a2ui_tool_log') {
            onAguiRef.current(payload)
          }
          if (payload.type === 'RUN_FINISHED') {
            onRunFinishedRef.current?.()
          }
          if (payload.type === 'THREAD_UPDATED') {
            onAguiRef.current(payload)
          }
          if (payload.type === 'monitor_status') {
            onMonitorStatusRef.current?.(payload)
          }
        } catch {
          // ignore malformed monitor events
        }
      }

      socket.onclose = () => {
        if (!cancelled) {
          reconnectTimer = window.setTimeout(connect, 3000)
        }
      }
    }

    void getAgentMonitorStatus(threadId)
      .then(status => {
        if (cancelled || status.completed) return
        return startAgentMonitor(threadId)
      })
      .catch(() => {
        // monitor may already be running or thread not ready yet
      })
    connect()

    return () => {
      cancelled = true
      if (reconnectTimer != null) window.clearTimeout(reconnectTimer)
      socket?.close()
    }
  }, [enabled, symbol, threadId])
}
