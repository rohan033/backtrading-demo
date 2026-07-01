import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { ChatMessageList, type ChatMessageListHandle } from '../../../components/ui/chat-message-list'
import {
  AGENT_THREAD_MESSAGE_PAGE_SIZE,
  getAgentThread,
  listAgentThreadMessages,
  messageToThreadChatRow,
  type AgentThread,
} from '../../../lib/agentThreads'
import {
  useCursorAgentChat,
  type AgentInteractionMode,
  type ChatMessage,
} from '../../../lib/useCursorAgentChat'

type Props = {
  threadId: string
  onThreadUpdated: (thread: AgentThread) => void
}

const MODE_LABELS: Record<AgentInteractionMode, string> = {
  ask: 'Plan',
  execute: 'Trade',
}

export default function AgentModeChatColumn({ threadId, onThreadUpdated }: Props) {
  const [thread, setThread] = useState<AgentThread | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>('ask')
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [oldestMessageId, setOldestMessageId] = useState<string | null>(null)
  const chatListRef = useRef<ChatMessageListHandle>(null)

  const toChatRows = useCallback(
    (rows: Awaited<ReturnType<typeof listAgentThreadMessages>>['messages']) =>
      rows.map(row => ({
        ...messageToThreadChatRow(row),
        streaming: false,
      })) as ChatMessage[],
    [],
  )

  const onThreadUpdatedRef = useRef(onThreadUpdated)
  onThreadUpdatedRef.current = onThreadUpdated

  const refreshThread = useCallback(async () => {
    const next = await getAgentThread(threadId)
    setThread(next)
    onThreadUpdatedRef.current(next)
  }, [threadId])

  const {
    messages,
    health,
    connected,
    sending,
    error: chatError,
    sendMessage,
    stopMessage,
    hydrateMessages,
    prependMessages,
    resetAgent,
  } = useCursorAgentChat(true, interactionMode, threadId, () => {
    void refreshThread()
  }, true)

  const loadOlderMessages = useCallback(async () => {
    if (!hasMoreOlder || loadingOlder || !oldestMessageId) return
    setLoadingOlder(true)
    chatListRef.current?.preserveScrollOnPrepend()
    try {
      const page = await listAgentThreadMessages(threadId, {
        before: oldestMessageId,
        limit: AGENT_THREAD_MESSAGE_PAGE_SIZE,
      })
      prependMessages(toChatRows(page.messages))
      setHasMoreOlder(page.has_more)
      setOldestMessageId(page.oldest_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load older messages')
    } finally {
      setLoadingOlder(false)
    }
  }, [hasMoreOlder, loadingOlder, oldestMessageId, prependMessages, threadId, toChatRows])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      setHasMoreOlder(false)
      setOldestMessageId(null)
      setDraft('')
      try {
        const [nextThread, page] = await Promise.all([
          getAgentThread(threadId),
          listAgentThreadMessages(threadId, { limit: AGENT_THREAD_MESSAGE_PAGE_SIZE }),
        ])
        if (cancelled) return
        setThread(nextThread)
        setHasMoreOlder(page.has_more)
        setOldestMessageId(page.oldest_id)
        resetAgent(nextThread.cursor_agent_id || null)
        hydrateMessages(toChatRows(page.messages))
        onThreadUpdatedRef.current(nextThread)
        window.requestAnimationFrame(() => chatListRef.current?.scrollToBottom())
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load thread')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [threadId, hydrateMessages, resetAgent, toChatRows])

  const statusText = useMemo(() => {
    if (!health?.configured) return health?.message || 'Agent not configured'
    if (!connected) return 'Connecting…'
    if (!health.ready) return health.message || 'Agent unavailable'
    return health.model ? `Live · ${health.model}` : 'Live'
  }, [connected, health])

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    const ok = await sendMessage(text)
    if (ok) setDraft('')
  }

  if (loading) {
    return (
      <section className="am-column">
        <div className="am-column-header am-column-header--center">Conversation</div>
        <div className="am-chat-empty">Loading thread…</div>
      </section>
    )
  }

  if (!thread) {
    return (
      <section className="am-column">
        <div className="am-column-header am-column-header--center">Conversation</div>
        <div className="am-chat-empty">{error || 'Thread not found'}</div>
      </section>
    )
  }

  return (
    <section className="am-column am-chat-column">
      <div className="am-column-header am-column-header--center">Conversation</div>
      <div className="am-chat-tab am-chat-tab--active">{thread.title}</div>
      <div className="am-chat-messages">
        <ChatMessageList
          ref={chatListRef}
          messages={messages}
          className="px-2 py-3 sm:px-3"
          pinToBottom
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlderMessages}
          emptyState={
            <div className="am-chat-empty">
              Agent UI elements render here as the thread runs.
            </div>
          }
        />
      </div>
      <div className="am-chat-compose">
        <div className="am-chat-toolbar">
          <div className="am-mode-toggle" role="group" aria-label="Agent mode">
            {(['ask', 'execute'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={interactionMode === mode}
                onClick={() => setInteractionMode(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <span className="am-chat-status">{statusText}</span>
        </div>
        <div className="am-chat-input-row">
          <textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submit()
              }
            }}
            rows={2}
            placeholder="What's your trading plan today?"
            className="am-chat-input"
          />
          <button
            type="button"
            className="am-chat-send"
            onClick={() => { void submit() }}
            disabled={sending || !draft.trim() || !connected}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          {sending ? (
            <button type="button" className="am-chat-stop" onClick={stopMessage}>
              Stop
            </button>
          ) : null}
        </div>
        {chatError || error ? (
          <p className="am-error" style={{ marginTop: 8, marginBottom: 0 }}>{chatError || error}</p>
        ) : null}
      </div>
    </section>
  )
}
