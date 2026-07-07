import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  pollTradingSessionEvents,
  type TradingSessionEvent,
  type TradingSessionState,
} from '@/lib/tradingSessions'

function wsUrl(sessionId: string, sinceId: number): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = window.location.host
  const params = sinceId > 0 ? `?since_id=${sinceId}` : ''
  return `${proto}//${host}/ws/control/trading-sessions/${encodeURIComponent(sessionId)}${params}`
}

export type AgentTurn = {
  runId: string
  state?: string
  tools: TradingSessionEvent[]
  thinking: TradingSessionEvent[]
  texts: TradingSessionEvent[]
  finished?: TradingSessionEvent
  startedAt: string
}

function runIdFromEvent(event: TradingSessionEvent): string {
  const payload = event.payload || {}
  return String(payload.run_id || payload.runId || 'default')
}

export function groupEventsIntoTurns(events: TradingSessionEvent[]): AgentTurn[] {
  const turns: AgentTurn[] = []
  let current: AgentTurn | null = null

  for (const event of events) {
    if (event.event_type === 'agent_run_started') {
      current = {
        runId: runIdFromEvent(event),
        state: String(event.payload?.state || ''),
        tools: [],
        thinking: [],
        texts: [],
        startedAt: event.created_at,
      }
      turns.push(current)
      continue
    }
    if (!current) continue

    if (event.event_type === 'agent_tool_call') current.tools.push(event)
    else if (event.event_type === 'agent_thinking') current.thinking.push(event)
    else if (event.event_type === 'agent_text') current.texts.push(event)
    else if (event.event_type === 'agent_run_finished') current.finished = event
  }
  return turns
}

export function useTradingSessionEvents(
  sessionId: string | null,
  sessionState?: TradingSessionState | null,
) {
  const [events, setEvents] = useState<TradingSessionEvent[]>([])
  const [connected, setConnected] = useState(false)
  const [polling, setPolling] = useState(false)
  const lastEventIdRef = useRef(0)
  const wsRef = useRef<WebSocket | null>(null)
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeSessionIdRef = useRef<string | null>(sessionId)

  useEffect(() => {
    activeSessionIdRef.current = sessionId
  }, [sessionId])

  const appendEvents = useCallback((incoming: TradingSessionEvent[]) => {
    if (!incoming.length) return
    setEvents(prev => {
      const seen = new Set(prev.map(e => e.id))
      const merged = [...prev]
      for (const event of incoming) {
        if (seen.has(event.id)) continue
        seen.add(event.id)
        merged.push(event)
        lastEventIdRef.current = Math.max(lastEventIdRef.current, event.id)
      }
      merged.sort((a, b) => a.id - b.id)
      return merged
    })
  }, [])

  const stopPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current)
      pollTimerRef.current = null
    }
    setPolling(false)
  }, [])

  const startPoll = useCallback((id: string) => {
    stopPoll()
    setPolling(true)
    const tick = async () => {
      if (activeSessionIdRef.current !== id) return
      try {
        const rows = await pollTradingSessionEvents(id, lastEventIdRef.current)
        if (activeSessionIdRef.current !== id) return
        appendEvents(rows)
      } catch {
        // keep polling
      }
    }
    void tick()
    pollTimerRef.current = setInterval(() => { void tick() }, 2000)
  }, [appendEvents, stopPoll])

  useEffect(() => {
    if (!sessionId) {
      setEvents([])
      setConnected(false)
      stopPoll()
      return
    }

    lastEventIdRef.current = 0
    setEvents([])

    const ws = new WebSocket(wsUrl(sessionId, 0))
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      stopPoll()
    }

    ws.onmessage = (msg) => {
      if (activeSessionIdRef.current !== sessionId) return
      try {
        const data = JSON.parse(String(msg.data))
        if (data.type === 'event' && data.event) {
          appendEvents([data.event as TradingSessionEvent])
        }
      } catch {
        // ignore
      }
    }

    ws.onclose = () => {
      setConnected(false)
      startPoll(sessionId)
    }

    ws.onerror = () => {
      ws.close()
    }

    return () => {
      ws.close()
      wsRef.current = null
      stopPoll()
    }
  }, [sessionId, appendEvents, startPoll, stopPoll])

  const agentRunning = useMemo(() => {
    if (sessionState === 'stopped') return false
    const turns = groupEventsIntoTurns(events)
    const last = turns[turns.length - 1]
    if (!last) return false
    return !last.finished
  }, [events, sessionState])

  const currentState = useMemo((): TradingSessionState | null => {
    let state: TradingSessionState | null = null
    for (const event of events) {
      if (event.event_type === 'state_entered' && event.payload?.state) {
        state = String(event.payload.state) as TradingSessionState
      }
    }
    return state
  }, [events])

  const turns = useMemo(() => groupEventsIntoTurns(events), [events])

  return {
    events,
    turns,
    connected,
    polling,
    agentRunning,
    currentState,
    lastEventId: lastEventIdRef.current,
  }
}
