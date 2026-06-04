import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Info, Globe } from 'lucide-react'

import AiResearchActionsPanel, { ActionsToggleButton } from '../../components/AiResearchActionsPanel'
import { EdgarSearchBar } from '../../components/EdgarSearchBar'
import { buildPromptWithEdgarContext, formatEdgarDraftLine } from '../../lib/edgar'
import { ChatMessageList, type ChatMessageListHandle } from '../../components/ui/chat-message-list'
import {
  getResearchSession,
  listResearchMessages,
  MESSAGE_PAGE_SIZE,
  messageToChatRow,
  updateResearchSession,
  type AiResearchSession,
} from '../../lib/aiResearch'
import { formatDbTimestamp } from '../../lib/datetime'
import {
  useCursorAgentChat,
  type AgentInteractionMode,
  type ChatMessage,
} from '../../lib/useCursorAgentChat'
import './ai-research.css'

function AiTextMark() {
  return (
    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-violet-500/30 to-sky-400/30 text-[10px] font-semibold tracking-tight text-white ring-1 ring-white/10">
      AI
    </span>
  )
}

export function AiResearchSessionPage() {
  const { sessionId = '' } = useParams()
  const [session, setSession] = useState<AiResearchSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState('')
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>('ask')
  const [webSearchEnabled, setWebSearchEnabled] = useState(true)
  const [editingTitle, setEditingTitle] = useState(false)
  const [actionsOpen, setActionsOpen] = useState(false)
  const [statsOpen, setStatsOpen] = useState(false)
  const [hasMoreOlder, setHasMoreOlder] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [oldestMessageId, setOldestMessageId] = useState<string | null>(null)
  const [edgarSymbol, setEdgarSymbol] = useState('')
  const chatListRef = useRef<ChatMessageListHandle>(null)
  const statsRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLTextAreaElement>(null)

  const resizeTitleField = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [])

  const toChatRows = useCallback(
    (rows: Awaited<ReturnType<typeof listResearchMessages>>['messages']) =>
      rows.map(row => ({
        ...messageToChatRow(row),
        streaming: false,
      })) as ChatMessage[],
    [],
  )

  const onSessionUpdatedRef = useRef<() => Promise<void>>(async () => {})

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
  } = useCursorAgentChat(true, interactionMode, sessionId, () => {
    void onSessionUpdatedRef.current()
  }, webSearchEnabled)

  const reloadMessages = useCallback(async () => {
    if (!sessionId) return
    const page = await listResearchMessages(sessionId, { limit: MESSAGE_PAGE_SIZE })
    setHasMoreOlder(page.has_more)
    setOldestMessageId(page.oldest_id)
    hydrateMessages(toChatRows(page.messages))
    window.requestAnimationFrame(() => chatListRef.current?.scrollToBottom())
  }, [hydrateMessages, sessionId, toChatRows])

  const refreshSession = useCallback(async () => {
    if (!sessionId) return
    const next = await getResearchSession(sessionId)
    setSession(next)
    setInteractionMode(next.interaction_mode || 'ask')
    setWebSearchEnabled(next.metadata?.web_search_enabled !== false)
    await reloadMessages()
  }, [reloadMessages, sessionId])

  useEffect(() => {
    onSessionUpdatedRef.current = refreshSession
  }, [refreshSession])

  const loadOlderMessages = useCallback(async () => {
    if (!sessionId || !hasMoreOlder || loadingOlder || !oldestMessageId) return
    setLoadingOlder(true)
    chatListRef.current?.preserveScrollOnPrepend()
    try {
      const page = await listResearchMessages(sessionId, {
        before: oldestMessageId,
        limit: MESSAGE_PAGE_SIZE,
      })
      prependMessages(toChatRows(page.messages))
      setHasMoreOlder(page.has_more)
      setOldestMessageId(page.oldest_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load older messages')
    } finally {
      setLoadingOlder(false)
    }
  }, [hasMoreOlder, loadingOlder, oldestMessageId, prependMessages, sessionId, toChatRows])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      setError('')
      setHasMoreOlder(false)
      setOldestMessageId(null)
      try {
        const [nextSession, page] = await Promise.all([
          getResearchSession(sessionId),
          listResearchMessages(sessionId, { limit: MESSAGE_PAGE_SIZE }),
        ])
        if (cancelled) return
        setSession(nextSession)
        setInteractionMode(nextSession.interaction_mode || 'ask')
        setWebSearchEnabled(nextSession.metadata?.web_search_enabled !== false)
        setHasMoreOlder(page.has_more)
        setOldestMessageId(page.oldest_id)
        resetAgent(nextSession.cursor_agent_id || null)
        hydrateMessages(toChatRows(page.messages))
        window.requestAnimationFrame(() => chatListRef.current?.scrollToBottom())
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load session')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, hydrateMessages, resetAgent, toChatRows])

  useEffect(() => {
    if (editingTitle) {
      resizeTitleField(titleRef.current)
      titleRef.current?.focus()
      titleRef.current?.select()
    }
  }, [editingTitle, session?.title, resizeTitleField])

  useEffect(() => {
    if (!statsOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!statsRef.current?.contains(event.target as Node)) {
        setStatsOpen(false)
      }
    }
    window.addEventListener('mousedown', onPointerDown)
    return () => window.removeEventListener('mousedown', onPointerDown)
  }, [statsOpen])

  const statusText = useMemo(() => {
    if (!health?.configured) return health?.message || 'Cursor agent not configured'
    if (!connected) return 'Connecting to Strategy AI…'
    if (!health.ready) return health.message || 'Strategy AI unavailable'
    return health.model ? `Connected · ${health.model}` : 'Connected'
  }, [connected, health])

  const submit = async () => {
    const text = draft.trim()
    const prompt = buildPromptWithEdgarContext(text, edgarSymbol)
    if (!prompt.trim()) return
    const ok = await sendMessage(prompt)
    if (ok) setDraft('')
  }

  const appendEdgarPromptToDraft = (symbol: string, searchUrl: string) => {
    const line = formatEdgarDraftLine(symbol, searchUrl)
    setDraft(prev => {
      const base = prev.trim()
      if (!base) return line
      if (base.includes(searchUrl)) return base
      return `${base}\n\n${line}`
    })
  }

  const saveTitle = async (title: string) => {
    if (!sessionId) return
    const next = await updateResearchSession(sessionId, { title })
    setSession(next)
    setEditingTitle(false)
  }

  const toggleWebSearch = async (enabled: boolean) => {
    setWebSearchEnabled(enabled)
    if (!sessionId) return
    const metadata = { ...(session?.metadata || {}), web_search_enabled: enabled }
    try {
      const next = await updateResearchSession(sessionId, { metadata })
      setSession(next)
    } catch {
      // keep local toggle; backend will persist on next chat send
    }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-secondary">
        Loading research session…
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-sm text-red">{error || 'Session not found'}</p>
        <Link to="/learn/research" className="text-sm text-accent hover:underline">← Back to AI Research</Link>
      </div>
    )
  }

  const actionCount = session.actions?.length ?? 0

  return (
    <div className="ai-research-ui relative flex h-full min-h-0">
      <div className={`flex min-w-0 flex-1 flex-col ${actionsOpen ? 'mr-[28rem]' : ''}`}>
        <div className="border-b border-border px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <AiTextMark />
              <div className="min-w-0 flex-1">
                <Link to="/learn/research" className="text-[11px] text-accent hover:underline">← AI Research</Link>
                {editingTitle ? (
                  <textarea
                    ref={titleRef}
                    key={session.title}
                    defaultValue={session.title}
                    rows={1}
                    aria-label="Session title"
                    onInput={e => resizeTitleField(e.currentTarget)}
                    onBlur={e => {
                      const value = e.target.value.trim()
                      if (value && value !== session.title) {
                        void saveTitle(value)
                      } else {
                        setEditingTitle(false)
                        resizeTitleField(e.currentTarget)
                      }
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        e.currentTarget.blur()
                      }
                      if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditingTitle(false)
                      }
                    }}
                    className="mt-1 block w-full resize-none overflow-hidden bg-transparent text-lg font-semibold leading-snug tracking-tight text-text-primary outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingTitle(true)}
                    title="Click to edit title"
                    className="mt-1 block w-full text-left text-lg font-semibold leading-snug tracking-tight text-text-primary ai-research-session-title"
                  >
                    <span className="whitespace-pre-wrap">{session.title}</span>
                  </button>
                )}
                <div className="relative mt-2" ref={statsRef}>
                  <button
                    type="button"
                    title="Session info"
                    aria-label="Session info"
                    aria-expanded={statsOpen}
                    onClick={() => setStatsOpen(open => !open)}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/70 px-2 py-1.5 text-xs text-text-secondary transition-colors hover:border-accent/40 hover:text-accent"
                  >
                    <Info className="h-4 w-4" />
                    Session info
                  </button>
                  {statsOpen ? (
                    <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-lg border border-border bg-card p-3 text-xs shadow-xl">
                      <div className="mb-2 text-[10px] font-medium uppercase tracking-wider text-accent">Session info</div>
                      <dl className="space-y-2 text-text-secondary">
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide">Session ID</dt>
                          <dd className="mt-0.5 break-all font-mono text-[11px] text-text-primary">{session.session_id}</dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide">Updated</dt>
                          <dd className="mt-0.5 text-text-primary">
                            {formatDbTimestamp(session.last_message_at || session.updated_at)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[10px] uppercase tracking-wide">Actions</dt>
                          <dd className="mt-0.5 text-text-primary">{actionCount}</dd>
                        </div>
                        {session.summary ? (
                          <div>
                            <dt className="text-[10px] uppercase tracking-wide">Summary</dt>
                            <dd className="mt-0.5 whitespace-pre-wrap text-text-primary">{session.summary}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
            {!actionsOpen ? <ActionsToggleButton actionCount={actionCount} onClick={() => setActionsOpen(true)} /> : null}
          </div>
        </div>

        <ChatMessageList
          ref={chatListRef}
          messages={messages}
          className="px-2 py-4 sm:px-4"
          pinToBottom
          hasMoreOlder={hasMoreOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={loadOlderMessages}
          emptyState={
            <div className="rounded border border-dashed border-border p-8 text-center text-text-secondary">
              Ask about stocks, strategy ideas, or deployment steps. Suggested actions will appear in the right panel.
            </div>
          }
        />

        <div className="border-t border-border/80 bg-primary/30 px-5 py-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex rounded-lg border border-border/60 bg-primary/50 p-0.5"
                role="group"
                aria-label="Agent interaction mode"
              >
                {(['ask', 'execute'] as const).map(mode => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={interactionMode === mode}
                    onClick={() => setInteractionMode(mode)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
                      interactionMode === mode
                        ? mode === 'execute'
                          ? 'bg-amber-500/20 text-amber-200'
                          : 'bg-card text-text-primary shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={sending}
                aria-pressed={webSearchEnabled}
                aria-label="Toggle web search for stock analysis"
                title={
                  webSearchEnabled
                    ? 'Web search on — agent can look up live market data'
                    : 'Web search off — answers use repo and saved data only'
                }
                onClick={() => void toggleWebSearch(!webSearchEnabled)}
                className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  webSearchEnabled
                    ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                    : 'border-border/60 bg-primary/50 text-text-secondary hover:text-text-primary'
                }`}
              >
                <Globe className="h-3.5 w-3.5" />
                Web search
              </button>
            </div>
            <span className="text-[11px] text-text-secondary">{statusText}</span>
          </div>
          <EdgarSearchBar
            onSymbolChange={setEdgarSymbol}
            onEdgarSearchClick={(symbol, searchUrl) => appendEdgarPromptToDraft(symbol, searchUrl)}
          />
          <div className="mt-2 flex items-end gap-2">
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  submit()
                }
              }}
              rows={2}
              placeholder="Research a symbol, compare setups, or ask the agent to propose a strategy…"
              className="min-h-[44px] flex-1 resize-y rounded-lg border border-border bg-primary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-secondary focus:border-accent/60"
            />
            <button
              type="button"
              onClick={submit}
              disabled={sending || !draft.trim() || !connected}
              className="rounded-lg bg-accent/20 px-4 py-2.5 text-xs font-medium text-accent transition-colors hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
            {sending ? (
              <button
                type="button"
                onClick={stopMessage}
                className="rounded-lg border border-border px-4 py-2.5 text-xs font-medium text-text-secondary"
              >
                Stop
              </button>
            ) : null}
          </div>
          {chatError || error ? (
            <p className="mt-2 text-[11px] text-red-300">{chatError || error}</p>
          ) : null}
        </div>
      </div>

      {actionsOpen ? (
        <AiResearchActionsPanel
          session={session}
          onClose={() => setActionsOpen(false)}
          onSessionUpdated={setSession}
        />
      ) : null}
    </div>
  )
}
