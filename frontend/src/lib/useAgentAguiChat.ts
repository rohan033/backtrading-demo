import { useCallback, useRef, useState } from 'react'

import { userTextSurface } from '@/components/agent/A2uiRenderer'
import { dedupeSurfaces } from '@/lib/agentA2uiHydrate'
import { isA2uiSurfaceMessage, type A2uiSurfaceMessage } from '@/lib/agentA2uiCatalog'

export type AgentInteractionMode = 'ask' | 'execute'

export type AgentAguiChatState = {
  surfaces: A2uiSurfaceMessage[]
  sending: boolean
  error: string
  connected: boolean
}

export type AgentRunContext = {
  broker: 'angel' | 'etoro'
  accountEnv: 'live' | 'demo'
}

const AGUI_RUN_URL = '/api/control/agent/agui/run'

function parseSseChunk(buffer: string): { events: Record<string, unknown>[]; rest: string } {
  const events: Record<string, unknown>[] = []
  const parts = buffer.split('\n\n')
  const rest = parts.pop() || ''
  for (const part of parts) {
    for (const line of part.split('\n')) {
      if (line.startsWith('data:')) {
        const raw = line.slice(5).trim()
        if (!raw) continue
        try {
          events.push(JSON.parse(raw) as Record<string, unknown>)
        } catch {
          // ignore malformed chunks
        }
      }
    }
  }
  return { events, rest }
}

export function useAgentAguiChat(
  threadId: string,
  interactionMode: AgentInteractionMode,
  onRunFinished?: () => void,
  onThreadUpdated?: (patch: { title?: string; metadata?: Record<string, unknown> }) => void,
  getRunContext?: () => AgentRunContext,
) {
  const [surfaces, setSurfaces] = useState<A2uiSurfaceMessage[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const agentIdRef = useRef<string | null>(null)

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setSending(false)
  }, [])

  const sendMessage = useCallback(
    async (prompt: string) => {
      const text = prompt.trim()
      if (!text || sending) return false

      const userId = `user-${Date.now()}`
      setSurfaces(prev => [...prev, userTextSurface(text, userId)])
      setSending(true)
      setError('')

      const controller = new AbortController()
      abortRef.current = controller
      const runContext = getRunContext?.()

      try {
        const res = await fetch(AGUI_RUN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({
            thread_id: threadId,
            prompt: text,
            agent_id: agentIdRef.current,
            interaction_mode: interactionMode,
            web_search_enabled: true,
            broker: runContext?.broker,
            account_env: runContext?.accountEnv,
          }),
          signal: controller.signal,
        })

        if (!res.ok || !res.body) {
          throw new Error(`Agent run failed (${res.status})`)
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const parsed = parseSseChunk(buffer)
          buffer = parsed.rest
          for (const event of parsed.events) {
            if (isA2uiSurfaceMessage(event)) {
              setSurfaces(prev => dedupeSurfaces([...prev, event]))
            }
            if (event.type === 'RUN_ERROR') {
              setError(String(event.message || 'Agent error'))
            }
            if (event.type === 'THREAD_UPDATED') {
              onThreadUpdated?.({
                title: typeof event.title === 'string' ? event.title : undefined,
                metadata: (event.metadata || {}) as Record<string, unknown>,
              })
            }
            if (event.type === 'UI_PHASE_CHANGED') {
              onRunFinished?.()
            }
            if (event.type === 'RUN_FINISHED') {
              onRunFinished?.()
            }
          }
        }

        onRunFinished?.()
        return true
      } catch (err) {
        if (controller.signal.aborted) {
          setError('')
        } else {
          setError(err instanceof Error ? err.message : 'Failed to send message')
        }
        return false
      } finally {
        setSending(false)
        abortRef.current = null
      }
    },
    [getRunContext, interactionMode, onRunFinished, onThreadUpdated, sending, threadId],
  )

  const resetSurfaces = useCallback((rows: A2uiSurfaceMessage[]) => {
    setSurfaces(dedupeSurfaces(rows))
  }, [])

  const pushAguiEvent = useCallback(
    (event: Record<string, unknown>) => {
      if (isA2uiSurfaceMessage(event)) {
        setSurfaces(prev => dedupeSurfaces([...prev, event]))
      }
      if (event.type === 'THREAD_UPDATED') {
        onThreadUpdated?.({
          title: typeof event.title === 'string' ? event.title : undefined,
          metadata: (event.metadata || {}) as Record<string, unknown>,
        })
      }
      if (event.type === 'RUN_ERROR') {
        setError(String(event.message || 'Agent error'))
      }
    },
    [onThreadUpdated],
  )

  const appendSurface = useCallback((surface: A2uiSurfaceMessage) => {
    setSurfaces(prev => dedupeSurfaces([...prev, surface]))
  }, [])

  return {
    surfaces,
    sending,
    error,
    connected: true,
    sendMessage,
    stop,
    resetSurfaces,
    pushAguiEvent,
    appendSurface,
  }
}
