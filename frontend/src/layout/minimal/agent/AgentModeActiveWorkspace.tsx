import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  AGENT_THREAD_MESSAGE_PAGE_SIZE,
  getThreadBrokerContext,
  getThreadUiPhase,
  listAgentThreadMessages,
  type AgentThread,
} from '@/lib/agentThreads'
import { observationSurface, surfacesFromThreadMessages } from '@/lib/agentA2uiHydrate'
import type { AgentInteractionMode } from '@/lib/useAgentAguiChat'
import { useAgentAguiChat } from '@/lib/useAgentAguiChat'
import { useAgentThreadExecutions } from '@/hooks/useAgentThreadExecutions'
import { useAgentThreadFocus } from '@/hooks/useAgentThreadFocus'
import { useMarketPreviewFeed } from '@/hooks/useMarketPreviewFeed'
import { useResolvedAgentFocus } from '@/hooks/useResolvedAgentFocus'
import { defaultAccountEnv, type WatchlistBroker } from '@/lib/watchlistBrokers'

import AgentModeActivityPanel from './AgentModeActivityPanel'
import AgentModeTradingPanel from './AgentModeTradingPanel'

type Props = {
  thread: AgentThread
  onRunFinished: () => void
  onThreadPatch: (patch: { title?: string; metadata?: Record<string, unknown> }) => void
}

export default function AgentModeActiveWorkspace({
  thread,
  onRunFinished,
  onThreadPatch,
}: Props) {
  const uiPhase = getThreadUiPhase(thread)
  const metadataFocus = useAgentThreadFocus(thread)
  const { primaryExecutionId, primaryExecution, reconciledFocus } = useAgentThreadExecutions(
    thread,
    metadataFocus,
  )
  const focus = useResolvedAgentFocus(thread, reconciledFocus)
  const [interactionMode, setInteractionMode] = useState<AgentInteractionMode>(
    uiPhase === 'trading' ? 'execute' : 'ask',
  )
  const initialBroker = getThreadBrokerContext(thread)
  const [broker, setBroker] = useState<WatchlistBroker>(initialBroker.broker)
  const [accountEnv, setAccountEnv] = useState<'live' | 'demo'>(initialBroker.accountEnv)

  useEffect(() => {
    const ctx = getThreadBrokerContext(thread)
    setBroker(ctx.broker)
    setAccountEnv(ctx.accountEnv)
  }, [thread])

  const feedBroker = (focus?.broker || broker) as WatchlistBroker
  const feedEnv = focus?.account_env || accountEnv || defaultAccountEnv(feedBroker)

  const { ltp, streamStatus } = useMarketPreviewFeed({
    broker: feedBroker,
    token: focus?.token,
    symbol: focus?.symbol,
    exchange: focus?.exchange || (feedBroker === 'etoro' ? 'ETORO' : 'NSE'),
    account_env: feedEnv,
    enabled: Boolean(focus?.symbol),
  })

  const runContext = useCallback(
    () => ({ broker, accountEnv }),
    [accountEnv, broker],
  )

  const chat = useAgentAguiChat(
    thread.thread_id,
    interactionMode,
    onRunFinished,
    onThreadPatch,
    runContext,
  )

  useEffect(() => {
    let cancelled = false
    void listAgentThreadMessages(thread.thread_id, { limit: AGENT_THREAD_MESSAGE_PAGE_SIZE }).then(page => {
      if (cancelled) return
      chat.resetSurfaces(surfacesFromThreadMessages(page.messages, thread.actions || []))
    })
    return () => {
      cancelled = true
    }
  }, [thread.actions, thread.thread_id, chat.resetSurfaces])

  const executionStatus = useMemo(() => {
    const id = primaryExecutionId || focus?.execution_id
    if (!id) return primaryExecution?.status || null
    const action = thread.actions?.find(item => String(item.payload?.execution_id || '') === id)
    return action?.status || primaryExecution?.status || null
  }, [focus?.execution_id, primaryExecution?.status, primaryExecutionId, thread.actions])

  const activitySeed = useMemo(() => {
    if (!focus?.symbol || uiPhase !== 'trading') return null
    return observationSurface(focus, executionStatus)
  }, [executionStatus, focus, uiPhase])

  const handleBrokerChange = (nextBroker: WatchlistBroker, nextEnv: 'live' | 'demo') => {
    setBroker(nextBroker)
    setAccountEnv(nextEnv)
    onThreadPatch({ metadata: { ...thread.metadata, broker: nextBroker, account_env: nextEnv } })
  }

  if (uiPhase === 'chat') {
    return (
      <div className="am-active-grid am-active-grid--chat">
        <AgentModeActivityPanel
          threadId={thread.thread_id}
          variant="chat"
          focus={focus}
          executionId={primaryExecutionId}
          livePrice={ltp}
          interactionMode={interactionMode}
          onInteractionModeChange={setInteractionMode}
          broker={broker}
          accountEnv={accountEnv}
          onBrokerChange={handleBrokerChange}
          activitySeed={null}
          chat={chat}
          onRunFinished={onRunFinished}
        />
      </div>
    )
  }

  return (
    <div className="am-active-grid am-active-grid--split">
      <AgentModeTradingPanel
        thread={thread}
        focus={focus}
        ltp={ltp}
        streamStatus={streamStatus}
      />
      <AgentModeActivityPanel
        threadId={thread.thread_id}
        variant="activity"
        focus={focus}
        executionId={primaryExecutionId}
        livePrice={ltp}
        interactionMode={interactionMode}
        onInteractionModeChange={setInteractionMode}
        broker={broker}
        accountEnv={accountEnv}
        onBrokerChange={handleBrokerChange}
        activitySeed={activitySeed}
        chat={chat}
        onRunFinished={onRunFinished}
      />
    </div>
  )
}
