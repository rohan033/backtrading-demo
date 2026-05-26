import { useCallback, useEffect, useRef, useState } from 'react'

import {
  formatToolLabel,
  normalizeToolStatus,
  summarizeToolDetail,
  type ToolCallStatus,
} from '@/lib/tool-call-display'
import { stripAiActionBlocks } from '@/lib/aiActionBlocks'

export type AgentInteractionMode = 'ask' | 'execute'

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  streaming?: boolean
  toolName?: string
  toolStatus?: ToolCallStatus
  toolDetail?: string
}

export type AgentHealth = {
  configured: boolean
  ready: boolean
  model?: string
  message?: string
}

type CursorAgentEvent =
  | { type: 'start'; agent_id?: string; run_id?: string; model?: string }
  | { type: 'text_delta'; text?: string }
  | { type: 'done'; agent_id?: string; text?: string }
  | { type: 'stopped'; agent_id?: string; run_id?: string }
  | { type: 'error'; message?: string; phase?: string }
  | { type: 'health'; data?: AgentHealth }
  | { type: 'pong' }
  | { type: 'status'; message?: string }
  | { type: 'tool_call'; tool_name?: string; tool_status?: string; args?: string; input?: string; arguments?: string; path?: string; command?: string; parameters?: string; content?: string }
  | { type: 'message'; message_type?: string; text?: string }

const CONNECT_TIMEOUT_MS = 8000
const RECONNECT_DELAY_MS = 3000

function cursorAgentWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/control/cursor-agent`
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useCursorAgentChat(
  enabled: boolean,
  interactionMode: AgentInteractionMode = 'ask',
  researchSessionId: string | null = null,
  onResearchSessionUpdated?: () => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState<AgentHealth | null>(null)
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const socketRef = useRef<WebSocket | null>(null)
  const agentIdRef = useRef<string | null>(null)
  const researchSessionIdRef = useRef<string | null>(researchSessionId)
  const onResearchSessionUpdatedRef = useRef(onResearchSessionUpdated)
  const assistantDraftIdRef = useRef<string | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const connectTimerRef = useRef<number | null>(null)

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current != null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (connectTimerRef.current != null) {
      window.clearTimeout(connectTimerRef.current)
      connectTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    researchSessionIdRef.current = researchSessionId
  }, [researchSessionId])

  useEffect(() => {
    onResearchSessionUpdatedRef.current = onResearchSessionUpdated
  }, [onResearchSessionUpdated])

  const hydrateMessages = useCallback((rows: ChatMessage[]) => {
    setMessages(
      rows.map(row =>
        row.role === 'assistant'
          ? { ...row, content: stripAiActionBlocks(row.content) }
          : row,
      ),
    )
  }, [])

  const resetAgent = useCallback((agentId: string | null) => {
    agentIdRef.current = agentId
  }, [])

  const appendAssistantDelta = useCallback((delta: string) => {
    const draftId = assistantDraftIdRef.current
    if (!draftId) return
    setMessages(prev =>
      prev.map(msg =>
        msg.id === draftId
          ? { ...msg, content: msg.content + delta, streaming: true }
          : msg,
      ),
    )
  }, [])

  const finalizeAssistant = useCallback((finalText?: string, stopped = false) => {
    const draftId = assistantDraftIdRef.current
    if (!draftId) return
    assistantDraftIdRef.current = null
    setMessages(prev =>
      prev.map(msg =>
        msg.id === draftId
          ? {
              ...msg,
              content: finalText?.trim()
                ? stripAiActionBlocks(finalText)
                : stopped
                  ? msg.content || 'Response stopped.'
                  : stripAiActionBlocks(msg.content),
              streaming: false,
            }
          : msg,
      ),
    )
  }, [])

  const upsertToolCall = useCallback((event: Extract<CursorAgentEvent, { type: 'tool_call' }>) => {
    const toolName = event.tool_name?.trim() || 'tool'
    const toolStatus = normalizeToolStatus(event.tool_status)
    const toolDetail = summarizeToolDetail(event)
    const label = formatToolLabel(toolName)

    setMessages(prev => {
      let openIdx = -1
      for (let index = prev.length - 1; index >= 0; index -= 1) {
        const msg = prev[index]
        if (msg.role === 'tool' && msg.toolName === toolName && msg.toolStatus === 'running') {
          openIdx = index
          break
        }
      }

      if (openIdx >= 0) {
        return prev.map((msg, index) =>
          index === openIdx
            ? {
                ...msg,
                content: label,
                toolStatus,
                toolDetail: toolDetail || msg.toolDetail,
              }
            : msg,
        )
      }

      return [
        ...prev,
        {
          id: nextId('tool'),
          role: 'tool',
          content: label,
          toolName,
          toolStatus,
          toolDetail,
        },
      ]
    })
  }, [])

  const prependMessages = useCallback((rows: ChatMessage[]) => {
    setMessages(prev => {
      const existing = new Set(prev.map(msg => msg.id))
      const toAdd = rows.filter(row => !existing.has(row.id))
      if (!toAdd.length) return prev
      return [...toAdd, ...prev]
    })
  }, [])

  const handleEvent = useCallback(
    (event: CursorAgentEvent) => {
      if (event.type === 'health' && event.data) {
        setHealth(event.data)
        if (!event.data.ready && event.data.message) {
          setError(event.data.message)
        } else if (event.data.ready) {
          setError('')
        }
        return
      }

      if (event.type === 'start') {
        if (event.agent_id) agentIdRef.current = event.agent_id
        if (event.model) {
          setHealth(prev => ({ ...prev, configured: true, ready: true, model: event.model }))
        }
        setError('')
        return
      }

      if (event.type === 'text_delta' && event.text) {
        appendAssistantDelta(event.text)
        return
      }

      if (event.type === 'tool_call') {
        upsertToolCall(event)
        return
      }

      if (event.type === 'done') {
        if (event.agent_id) agentIdRef.current = event.agent_id
        finalizeAssistant(event.text)
        setSending(false)
        onResearchSessionUpdatedRef.current?.()
        return
      }

      if (event.type === 'stopped') {
        if (event.agent_id) agentIdRef.current = event.agent_id
        finalizeAssistant(undefined, true)
        setSending(false)
        return
      }

      if (event.type === 'error') {
        const message = event.message || 'Cursor agent error'
        setError(message)
        finalizeAssistant()
        setSending(false)
        setMessages(prev => {
          const last = prev[prev.length - 1]
          if (last?.role === 'system' && last.content === message) return prev
          return [
            ...prev,
            {
              id: nextId('system'),
              role: 'system',
              content: message,
            },
          ]
        })
      }
    },
    [appendAssistantDelta, finalizeAssistant, upsertToolCall],
  )

  useEffect(() => {
    if (!enabled) {
      clearTimers()
      setConnected(false)
      socketRef.current?.close()
      socketRef.current = null
      return undefined
    }

    let cancelled = false

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimerRef.current != null) return
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null
        if (!cancelled) connect()
      }, RECONNECT_DELAY_MS)
    }

    const connect = () => {
      if (cancelled) return

      clearTimers()
      setConnected(false)

      const socket = new WebSocket(cursorAgentWsUrl())
      socketRef.current = socket

      connectTimerRef.current = window.setTimeout(() => {
        if (cancelled || socket.readyState === WebSocket.OPEN) return
        setError('Control plane not reachable. Run make dev or make cp on port 8000.')
      }, CONNECT_TIMEOUT_MS)

      socket.onopen = () => {
        if (cancelled) return
        clearTimers()
        setConnected(true)
        setError('')
        socket.send(JSON.stringify({ type: 'health' }))
      }

      socket.onmessage = evt => {
        try {
          const payload = JSON.parse(evt.data) as CursorAgentEvent
          handleEvent(payload)
        } catch {
          setError('Invalid response from Cursor agent')
        }
      }

      socket.onerror = () => {
        if (cancelled) return
        setConnected(false)
        setError('WebSocket connection failed. Is the control plane running?')
      }

      socket.onclose = () => {
        if (cancelled) return
        setConnected(false)
        if (socketRef.current === socket) socketRef.current = null
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      cancelled = true
      clearTimers()
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [enabled, handleEvent, clearTimers])

  const sendMessage = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim()
      if (!trimmed || sending) return false

      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setError('Not connected to Strategy AI. Start the control plane with make dev.')
        return false
      }

      if (health && !health.ready) {
        setError(health.message || 'Cursor agent is not ready.')
        return false
      }

      setSending(true)
      setError('')

      const userMessage: ChatMessage = {
        id: nextId('user'),
        role: 'user',
        content: trimmed,
      }
      const assistantMessage: ChatMessage = {
        id: nextId('assistant'),
        role: 'assistant',
        content: '',
        streaming: true,
      }
      assistantDraftIdRef.current = assistantMessage.id

      setMessages(prev => [...prev, userMessage, assistantMessage])

      socket.send(
        JSON.stringify({
          type: 'chat',
          prompt: trimmed,
          agent_id: agentIdRef.current,
          interaction_mode: interactionMode,
          research_session_id: researchSessionIdRef.current,
        }),
      )
      return true
    },
    [health, interactionMode, sending],
  )

  const stopMessage = useCallback(() => {
    if (!sending) return false

    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      finalizeAssistant(undefined, true)
      setSending(false)
      return false
    }

    socket.send(JSON.stringify({ type: 'stop' }))
    finalizeAssistant(undefined, true)
    setSending(false)
    return true
  }, [finalizeAssistant, sending])

  return {
    messages,
    health,
    connected,
    sending,
    error,
    sendMessage,
    stopMessage,
    hydrateMessages,
    prependMessages,
    resetAgent,
  }
}
