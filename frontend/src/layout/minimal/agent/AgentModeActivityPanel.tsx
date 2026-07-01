import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { A2uiRenderer } from '@/components/agent/A2uiRenderer'
import { useAgentTradeMonitor } from '@/hooks/useAgentTradeMonitor'
import {
  isChatSurface,
  type A2uiSurfaceMessage,
  type A2uiUserAction,
} from '@/lib/agentA2uiCatalog'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import { updateAgentThread } from '@/lib/agentThreads'
import type { AgentAguiChatState, AgentInteractionMode } from '@/lib/useAgentAguiChat'
import {
  defaultAccountEnv,
  WATCHLIST_BROKER_OPTIONS,
  type WatchlistBroker,
} from '@/lib/watchlistBrokers'

const MODE_LABELS: Record<AgentInteractionMode, string> = {
  ask: 'Plan',
  execute: 'Trade',
}

type ChatApi = AgentAguiChatState & {
  sendMessage: (prompt: string) => Promise<boolean>
  stop: () => void
}

type Props = {
  threadId: string
  variant: 'chat' | 'activity'
  focus?: AgentThreadFocus | null
  executionId?: string | null
  livePrice?: number | null
  interactionMode: AgentInteractionMode
  onInteractionModeChange: (mode: AgentInteractionMode) => void
  broker: WatchlistBroker
  accountEnv: 'live' | 'demo'
  onBrokerChange: (broker: WatchlistBroker, accountEnv: 'live' | 'demo') => void
  activitySeed?: A2uiSurfaceMessage | null
  chat: ChatApi
  onRunFinished: () => void
}

export default function AgentModeActivityPanel({
  threadId,
  variant,
  focus,
  executionId,
  livePrice = null,
  interactionMode,
  onInteractionModeChange,
  broker,
  accountEnv,
  onBrokerChange,
  activitySeed = null,
  chat,
}: Props) {
  const [draft, setDraft] = useState('')
  const [toolLogOpen, setToolLogOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const { surfaces, sending, error, sendMessage, stop } = chat

  useAgentTradeMonitor({
    threadId,
    focus: focus || null,
    executionId: executionId || null,
    livePrice,
    interactionMode,
    sending,
    sendMessage,
    enabled: variant === 'activity' && Boolean(executionId),
  })

  const chatSurfaces = useMemo(() => {
    const rows = surfaces.filter(surface => isChatSurface(surface))
    if (variant !== 'activity' || !activitySeed) return rows
    const rest = rows.filter(surface => surface.messageId !== activitySeed.messageId)
    return [activitySeed, ...rest]
  }, [activitySeed, surfaces, variant])

  const toolLogs = useMemo(
    () => surfaces.filter(surface => surface.type === 'a2ui_tool_log'),
    [surfaces],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatSurfaces, sending])

  const handleBrokerSelect = (nextBroker: WatchlistBroker) => {
    const nextEnv = defaultAccountEnv(nextBroker)
    onBrokerChange(nextBroker, nextEnv)
    void updateAgentThread(threadId, {
      metadata: { broker: nextBroker, account_env: nextEnv },
    })
  }

  const handleEnvSelect = (nextEnv: 'live' | 'demo') => {
    onBrokerChange(broker, nextEnv)
    void updateAgentThread(threadId, {
      metadata: { broker, account_env: nextEnv },
    })
  }

  const handleA2uiAction = useCallback(async (action: A2uiUserAction) => {
    if (action.type === 'pick_symbol') {
      const symbol = action.symbol.split('-')[0]
      await sendMessage(`Set up a trade on ${symbol} (${broker} / ${accountEnv}). Show TopStockPicks if comparing, then StrategySetupForm.`)
      return
    }
    if (action.type === 'deploy_strategy') {
      const payload = action.payload
      const symbol = String(payload.symbol || '')
      const capital = payload.max_available_capital
      const target = payload.long_percent
      const stop = payload.short_percent
      const threshold = payload.initial_threshold
      const entry = payload.close_price
      const prompt = interactionMode === 'execute'
        ? `Deploy live strategy on ${symbol} (${broker} / ${accountEnv}): capital $${capital}, target ${target}%, stop ${stop}%, threshold ${threshold}%, entry ref ${entry}. Use create_strategy then start_strategy.`
        : `Switch to execute mode and deploy ${symbol} with capital $${capital}, target ${target}%, stop ${stop}%.`
      await sendMessage(prompt)
      return
    }
    if (action.type === 'send_prompt') {
      await sendMessage(action.prompt)
    }
  }, [accountEnv, broker, interactionMode, sendMessage])

  const submit = async () => {
    const text = draft.trim()
    if (!text) return
    const ok = await sendMessage(text)
    if (ok) setDraft('')
  }

  return (
    <section className={`am-activity-panel ${variant === 'chat' ? 'am-activity-panel--full' : ''}`}>
      <div className="am-column-header am-column-header--center">
        {variant === 'chat' ? 'Conversation' : 'Agent activity'}
      </div>
      <div className="am-activity-stream" ref={scrollRef}>
        {chatSurfaces.length ? (
          chatSurfaces.map(surface => (
            <A2uiRenderer
              key={surface.messageId}
              surface={surface}
              className="am-activity-item"
              onAction={handleA2uiAction}
            />
          ))
        ) : (
          <div className="am-chat-empty">
            {variant === 'chat'
              ? 'What\'s your trading plan today?'
              : 'Agent activity will appear here as the thread runs.'}
          </div>
        )}
      </div>
      {toolLogs.length ? (
        <div className="am-tool-log">
          <button
            type="button"
            className="am-tool-log__toggle"
            onClick={() => setToolLogOpen(prev => !prev)}
          >
            Tool log ({toolLogs.length}) {toolLogOpen ? '▾' : '▸'}
          </button>
          {toolLogOpen ? (
            <div className="am-tool-log__body">
              {toolLogs.slice(-12).map(surface => (
                <A2uiRenderer key={surface.messageId} surface={surface} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="am-chat-compose">
        <div className="am-chat-toolbar">
          <div className="am-broker-bar" role="group" aria-label="Broker">
            <select
              className="am-broker-select"
              value={broker}
              onChange={event => handleBrokerSelect(event.target.value as WatchlistBroker)}
              aria-label="Broker"
            >
              {WATCHLIST_BROKER_OPTIONS.map(option => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
            <select
              className="am-broker-select am-broker-select--env"
              value={accountEnv}
              onChange={event => handleEnvSelect(event.target.value as 'live' | 'demo')}
              aria-label="Account environment"
            >
              <option value="live">Live</option>
              <option value="demo">Demo</option>
            </select>
          </div>
          <div className="am-mode-toggle" role="group" aria-label="Agent mode">
            {(['ask', 'execute'] as const).map(mode => (
              <button
                key={mode}
                type="button"
                aria-pressed={interactionMode === mode}
                onClick={() => onInteractionModeChange(mode)}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          {sending ? <span className="am-chat-status">Running…</span> : null}
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
            disabled={sending || !draft.trim()}
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
          {sending ? (
            <button type="button" className="am-chat-stop" onClick={stop}>
              Stop
            </button>
          ) : null}
        </div>
        {error ? <p className="am-error" style={{ marginTop: 8, marginBottom: 0 }}>{error}</p> : null}
      </div>
    </section>
  )
}
