import { useCallback, useEffect, useRef, useState } from 'react'

export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  id: string
  role: ChatRole
  content: string
  streaming?: boolean
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
  | { type: 'error'; message?: string; phase?: string }
  | { type: 'health'; data?: AgentHealth }
  | { type: 'pong' }
  | { type: 'status'; message?: string }
  | { type: 'tool_call'; tool_name?: string; tool_status?: string }
  | { type: 'message'; message_type?: string; text?: string }

function cursorAgentWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/ws/control/cursor-agent`
}

function nextId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function useCursorAgentChat(enabled: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [health, setHealth] = useState<AgentHealth | null>(null)
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  const socketRef = useRef<WebSocket | null>(null)
  const agentIdRef = useRef<string | null>(null)
  const assistantDraftIdRef = useRef<string | null>(null)

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

  const finalizeAssistant = useCallback((finalText?: string) => {
    const draftId = assistantDraftIdRef.current
    if (!draftId) return
    assistantDraftIdRef.current = null
    setMessages(prev =>
      prev.map(msg =>
        msg.id === draftId
          ? {
              ...msg,
              content: finalText?.trim() ? finalText : msg.content,
              streaming: false,
            }
          : msg,
      ),
    )
  }, [])

  const handleEvent = useCallback(
    (event: CursorAgentEvent) => {
      if (event.type === 'health' && event.data) {
        setHealth(event.data)
        return
      }

      if (event.type === 'start') {
        if (event.agent_id) agentIdRef.current = event.agent_id
        if (event.model) {
          setHealth(prev => ({ ...prev, configured: true, ready: true, model: event.model }))
        }
        return
      }

      if (event.type === 'text_delta' && event.text) {
        appendAssistantDelta(event.text)
        return
      }

      if (event.type === 'done') {
        if (event.agent_id) agentIdRef.current = event.agent_id
        finalizeAssistant(event.text)
        setSending(false)
        return
      }

      if (event.type === 'error') {
        setError(event.message || 'Cursor agent error')
        finalizeAssistant()
        setSending(false)
        setMessages(prev => [
          ...prev,
          {
            id: nextId('system'),
            role: 'system',
            content: event.message || 'Cursor agent error',
          },
        ])
      }
    },
    [appendAssistantDelta, finalizeAssistant],
  )

  useEffect(() => {
    if (!enabled) {
      setConnected(false)
      socketRef.current?.close()
      socketRef.current = null
      return undefined
    }

    let cancelled = false
    const socket = new WebSocket(cursorAgentWsUrl())
    socketRef.current = socket

    socket.onopen = () => {
      if (cancelled) return
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
      setError('WebSocket connection failed')
    }

    socket.onclose = () => {
      if (cancelled) return
      setConnected(false)
    }

    return () => {
      cancelled = true
      socket.close()
      if (socketRef.current === socket) socketRef.current = null
    }
  }, [enabled, handleEvent])

  const sendMessage = useCallback(
    async (prompt: string) => {
      const trimmed = prompt.trim()
      if (!trimmed || sending) return false

      const socket = socketRef.current
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setError('Not connected to Cursor agent')
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
        }),
      )
      return true
    },
    [sending],
  )

  return {
    messages,
    health,
    connected,
    sending,
    error,
    sendMessage,
  }
}
