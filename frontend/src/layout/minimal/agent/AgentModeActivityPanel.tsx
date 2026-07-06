import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { A2uiRenderer } from '@/components/agent/A2uiRenderer'
import {
  compactSurfacesAfterDeploy,
  deployedSummarySurface,
} from '@/lib/agentA2uiHydrate'
import {
  isChatSurface,
  type A2uiSurfaceMessage,
  type A2uiUserAction,
} from '@/lib/agentA2uiCatalog'
import type { AgentThreadFocus } from '@/lib/agentThreads'
import { updateAgentThread } from '@/lib/agentThreads'
import { deployAgentStrategy } from '@/lib/agentStrategyDeploy'
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
  appendSurface?: (surface: A2uiSurfaceMessage) => void
  resetSurfaces?: (surfaces: A2uiSurfaceMessage[]) => void
}

type Props = {
  threadId: string
  variant: 'chat' | 'activity'
  focus?: AgentThreadFocus | null
  executionId?: string | null
  executionStatus?: string | null
  strategyDeployed?: boolean
  livePrice?: number | null
  interactionMode: AgentInteractionMode
  onInteractionModeChange: (mode: AgentInteractionMode) => void
  broker: WatchlistBroker
  accountEnv: 'live' | 'demo'
  onBrokerChange: (broker: WatchlistBroker, accountEnv: 'live' | 'demo') => void
  activitySeed?: A2uiSurfaceMessage | null
  chat: ChatApi
  onRunFinished: () => void
  onDeploySuccess?: () => void
}

export default function AgentModeActivityPanel({
  threadId,
  variant,
  focus,
  executionId,
  executionStatus,
  strategyDeployed: strategyDeployedProp,
  livePrice = null,
  interactionMode,
  onInteractionModeChange,
  broker,
  accountEnv,
  onBrokerChange,
  activitySeed = null,
  chat,
  onDeploySuccess,
}: Props) {
  const [draft, setDraft] = useState('')
  const [toolLogOpen, setToolLogOpen] = useState(false)
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedToBottomRef = useRef(true)

  const { surfaces, sending, error, sendMessage, stop, appendSurface, resetSurfaces } = chat

  const strategyDeployed = strategyDeployedProp ?? Boolean(executionId || focus?.execution_id)

  const chatSurfaces = useMemo(() => {
    const rows = surfaces.filter(surface => isChatSurface(surface))
    const compacted = compactSurfacesAfterDeploy(rows, strategyDeployed)
    if (variant !== 'activity' || !activitySeed) return compacted
    const rest = compacted.filter(surface => surface.messageId !== activitySeed.messageId)
    return [activitySeed, ...rest]
  }, [activitySeed, surfaces, strategyDeployed, variant])

  const toolLogs = useMemo(
    () => surfaces.filter(surface => surface.type === 'a2ui_tool_log'),
    [surfaces],
  )

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    const nearBottom = distanceFromBottom < 80
    if (pinnedToBottomRef.current || nearBottom) {
      el.scrollTop = el.scrollHeight
      pinnedToBottomRef.current = true
    }
  }, [chatSurfaces, sending])

  const handleActivityScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }, [])

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
      await sendMessage(
        `User selected ${symbol} (${broker} / ${accountEnv}). `
        + `Finalize setup for ${symbol}: use search_instruments for token/exchange, `
        + `emit ai_summary (highlights/lowlights/cautions from Finnhub news + your research), `
        + `then ai_action StrategySetupForm. Do NOT deploy or place orders until the user clicks Deploy.`,
      )
      return
    }
    if (action.type === 'deploy_strategy') {
      if (interactionMode !== 'execute') {
        await sendMessage(`Switch to execute mode and deploy ${String(action.payload.symbol || '')}.`)
        return
      }
      setDeployError('')
      setDeploying(true)
      try {
        const payload = action.payload
        const { executionId: newExecId, entryPrice } = await deployAgentStrategy({
          threadId,
          payload: {
            ...payload,
            broker,
            account_env: accountEnv,
            actionId: payload.actionId ? String(payload.actionId) : undefined,
            title: payload.title ? String(payload.title) : undefined,
          },
          broker,
          accountEnv,
          livePrice,
        })
        const summary = deployedSummarySurface(
          {
            symbol: String(payload.symbol || ''),
            token: payload.token ? String(payload.token) : null,
            exchange: String(payload.exchange || (broker === 'etoro' ? 'ETORO' : 'NSE')),
            broker,
            account_env: accountEnv,
            close_price: entryPrice,
            long_percent: Number(payload.long_percent ?? 0) || null,
            short_percent: Number(payload.short_percent ?? 0) || null,
            max_available_capital: Number(payload.max_available_capital ?? 0) || null,
            execution_id: newExecId,
          },
          newExecId,
          'running',
          entryPrice,
        )
        appendSurface?.(summary)
        resetSurfaces?.(compactSurfacesAfterDeploy([...surfaces, summary], true))
        onDeploySuccess?.()
      } catch (err) {
        setDeployError(err instanceof Error ? err.message : 'Deploy failed')
      } finally {
        setDeploying(false)
      }
      return
    }
    if (action.type === 'send_prompt') {
      await sendMessage(action.prompt)
    }
  }, [
    accountEnv,
    appendSurface,
    broker,
    interactionMode,
    livePrice,
    onDeploySuccess,
    resetSurfaces,
    sendMessage,
    surfaces,
    threadId,
  ])

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
      <div className="am-activity-stream" ref={scrollRef} onScroll={handleActivityScroll}>
        {chatSurfaces.length ? (
          chatSurfaces.map(surface => (
            <A2uiRenderer
              key={surface.messageId}
              surface={surface}
              className="am-activity-item"
              onAction={handleA2uiAction}
              broker={broker}
              accountEnv={accountEnv}
            />
          ))
        ) : (
          <div className="am-chat-empty">
            {variant === 'chat'
              ? 'What\'s your trading plan today?'
              : 'Agent activity will appear here as the thread runs.'}
          </div>
        )}
        {deployError ? <div className="am-chat-error">{deployError}</div> : null}
        {deploying ? <div className="am-chat-status">Placing order…</div> : null}
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
